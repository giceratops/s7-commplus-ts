/*
 * S7CommPlusDriver
 * Partly based on Snap7 (Sharp7.cs) by Davide Nardella, licensed under LGPL.
 * Ported to TypeScript.
 *
 * ===================================================================================================
 * PUBLIC API (for porting S7CommPlusConnection against it)
 * ===================================================================================================
 *   const client = new S7Client();
 *   client.onDataReceived = (pdu: Uint8Array, len: number) => void;
 *        // Each reassembled S7CommPlus PDU payload (TPKT/COTP header already stripped; after sslActivate()
 *        // it is the decrypted TLS data). `len === pdu.length`. NOTE: after TLS activation Node delivers
 *        // decrypted data per TLS read, exactly like the C# OnDataAvailable did.
 *   client.onClosed   = (hadError: boolean) => void;   // optional, new: connection closed / lost
 *   client.onError    = (err: Error) => void;          // optional, new: TLS errors (lastError = errOpenSSL)
 *   client.keyLogEnabled: boolean;     // opt-in (default false): write TLS secrets to "key_YYYYMMDD_hhmmss.log"
 *                                      // in the cwd (Wireshark SSLKEYLOGFILE format). Set BEFORE sslActivate().
 *   client.setConnectionParams(address: string, localTSAP: number, remoteTSAP: Uint8Array): number   // sync, 0
 *        // Connection does: setConnectionParams(address, 0x0600, new TextEncoder().encode("SIMATIC-ROOT-HMI"))
 *   await client.connect(): Promise<number>      // TCP + ISO connect (COTP CR/CC); 0 = ok, else S7Consts error
 *   await client.send(data: Uint8Array): Promise<number>   // S7+ payload; ISO-framed, or TLS-encrypted when
 *                                                          // TLS is active. Returns error code (0 = ok).
 *   await client.sslActivate(): Promise<number>  // from now on TLS. Returns after TLS is set up and the
 *        // ClientHello is on its way (does NOT wait for the handshake, as in C#); send() calls made
 *        // afterwards are queued until the handshake is done. Use `await client.tlsHandshake` to wait explicitly.
 *   client.tlsHandshake: Promise<void> | null    // resolves when the handshake is done; null before sslActivate
 *   client.sslDeactivate(): void
 *   client.getOMSExporterSecret(): Uint8Array | null   // 32 bytes, label "EXPERIMENTAL_OMS" (null if no TLS)
 *   client.exportKeyingMaterial(length, label, context?): Uint8Array | null
 *   client.disconnect(): number                  // synchronous (closes the socket immediately), returns 0
 *   client.connected: boolean                    // getter
 *   client.lastError(): number ; field `_lastError`
 *   client.getParam(paramNumber): { res: number, value: number } ; client.setParam(paramNumber, value): number
 *   client.requestedPduLength() / negotiatedPduLength() / execTime()
 *   getters/setters: pduSizeRequested (clamped 240..960), pduSizeNegotiated, plcPort, connTimeout,
 *                    recvTimeout, sendTimeout, executionTime
 *   S7Client.errorText(error: number): string    // static
 * ===================================================================================================
 */
import { appendFileSync } from "node:fs";
import { MsgSocket } from "./MsgSocket.js";
import { S7Consts } from "./S7Consts.js";
import { S7TlsChannel } from "../tls/S7TlsChannel.js";

const ISO_CR_HEAD = [
  // TPKT (RFC1006 Header)
  0x03, // RFC 1006 ID (3)
  0x00, // Reserved, always 0
  0x00, // High part of packet lenght (entire frame, payload and TPDU included)
  0x24, // Low part of packet lenght (entire frame, payload and TPDU included)
  // COTP (ISO 8073 Header)
  0x1f, // PDU Size Length
  0xe0, // CR - Connection Request ID
  0x00, // Dst Reference HI
  0x00, // Dst Reference LO
  0x00, // Src Reference HI
  0x01, // Src Reference LO
  0x00, // Class + Options Flags
  0xc0, // PDU Max Length ID
  0x01, // PDU Max Length HI
  0x0a, // PDU Max Length LO
  0xc1, // Src TSAP Identifier
  0x02, // Src TSAP Length (2 bytes)
  0x01, // Src TSAP HI (will be overwritten)
  0x00, // Src TSAP LO (will be overwritten)
  0xc2, // Dst TSAP Identifier
  0x10, // Dst TSAP Length (16 bytes)
  // From here the TSAP ID (String), e.g. SIMATIC-ROOT-HMI
];

// TPKT + ISO COTP Header (Connection Oriented Transport Protocol)
const TPKT_ISO = [
  0x03, 0x00,
  0x00, 0x1f, // Telegram Length (Data Size + 31 or 35)
  0x02, 0xf0, 0x80, // COTP (see above for info)
]; // 7 bytes

const ISOTCP = 102; // ISOTCP Port
const MinPduSizeToRequest = 240;
const MaxPduSizeToRequest = 960;
const DefaultTimeout = 2000;
const IsoHSize = 7; // TPKT+COTP Header Size

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export class S7Client {
  _lastError = 0;

  onDataReceived: ((pdu: Uint8Array, len: number) => void) | null = null;
  onClosed: ((hadError: boolean) => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  /** Opt-in: write TLS secrets to key_YYYYMMDD_hhmmss.log (e.g. for decrypting a Wireshark capture). */
  keyLogEnabled = false;

  private sslActive = false;
  private tlsChannel: S7TlsChannel | null = null;
  tlsHandshake: Promise<void> | null = null;
  private dateTimeStarted: Date = new Date();

  // Properties
  private _PDULength = 0;
  private _PduSizeRequested = 480;
  private _PLCPort = ISOTCP;
  private _RecvTimeout = DefaultTimeout;
  private _SendTimeout = DefaultTimeout;
  private _ConnTimeout = DefaultTimeout;

  // Privates
  private ipAddress = "";
  private localTSAP_HI = 0;
  private localTSAP_LO = 0;
  private remoteTSAP_S: Uint8Array = new Uint8Array(0);
  private lastPDUType = 0;
  private socket: MsgSocket;
  private time_ms = 0;
  private rxBuf: Buffer = Buffer.alloc(0);
  private isoWaiter: ((size: number, pduType: number) => void) | null = null;
  private isoWaitAbort: (() => void) | null = null;

  constructor() {
    this.socket = this.createSocket();
  }

  private createSocket(): MsgSocket {
    const s = new MsgSocket();
    s.connectTimeout = this._ConnTimeout;
    s.readTimeout = this._RecvTimeout;
    s.writeTimeout = this._SendTimeout;
    s.onData = (d) => this.onSocketData(d);
    s.onClose = (hadError) => {
      if (this.socket !== s) return;
      // Peer closed while waiting for the connection confirm: C# Receive() fails right away (0 bytes read).
      this.isoWaitAbort?.();
      this.rxBuf = Buffer.alloc(0);
      this.tlsChannel?.close();
      this.tlsChannel = null;
      this.sslActive = false;
      this.onClosed?.(hadError);
    };
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // TLS
  // ---------------------------------------------------------------------------------------------

  // Starts TLS and activates it from now on
  async sslActivate(): Promise<number> {
    try {
      const keyLogFile = "key_" + this.formatStartTime() + ".log";
      this.tlsChannel = new S7TlsChannel({
        // TLS wants to send data to the socket
        // TODO (as in C#): what if TLS wants to send data larger than one TPDU?
        writeData: (data) => {
          void this.sendIsoPacket(data);
        },
        // TLS reports finished (decrypted) data
        onData: (data) => this.onDataReceived?.(data, data.length),
        onKeyLog: this.keyLogEnabled
          ? (line) => {
              appendFileSync(keyLogFile, line.endsWith("\n") ? line : line + "\n");
            }
          : undefined,
        onError: (err) => {
          this._lastError = S7Consts.errOpenSSL;
          this.onError?.(err);
        },
      });
      this.tlsHandshake = this.tlsChannel.handshake;
      this.sslActive = true;
    } catch {
      return S7Consts.errOpenSSL;
    }
    return 0;
  }

  // Deactivates TLS
  sslDeactivate(): void {
    this.sslActive = false;
    this.tlsChannel?.close();
    this.tlsChannel = null;
    this.tlsHandshake = null;
  }

  private formatStartTime(): string {
    const d = this.dateTimeStarted;
    return (
      d.getFullYear().toString() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
    );
  }

  getOMSExporterSecret(): Uint8Array | null {
    if (this.tlsChannel === null) return null;
    return this.tlsChannel.getOMSExporterSecret();
  }

  exportKeyingMaterial(length: number, label: string, context?: Uint8Array): Uint8Array | null {
    if (this.tlsChannel === null) return null;
    return this.tlsChannel.exportKeyingMaterial(length, label, context);
  }

  // ---------------------------------------------------------------------------------------------
  // Receive / framing
  // ---------------------------------------------------------------------------------------------

  private onSocketData(d: Uint8Array): void {
    this.rxBuf = this.rxBuf.length === 0 ? Buffer.from(d) : Buffer.concat([this.rxBuf, d]);
    // reassemble ISO packets (TPKT length in bytes 2..3)
    while (this.rxBuf.length >= 4) {
      const size = (this.rxBuf[2] << 8) | this.rxBuf[3];
      if (size === IsoHSize) {
        // 0 bytes Data Packet (only TPKT+COTP = 7 bytes): skip
        if (this.rxBuf.length < IsoHSize) return;
        this.rxBuf = this.rxBuf.subarray(IsoHSize);
        continue;
      }
      if (size < IsoHSize) {
        // invalid, resynchronisation is impossible
        this.rxBuf = Buffer.alloc(0);
        this._lastError = S7Consts.errIsoInvalidPDU;
        return;
      }
      if (this.rxBuf.length < size) return;
      const pdu = this.rxBuf.subarray(0, size);
      this.rxBuf = this.rxBuf.subarray(size);
      this.lastPDUType = pdu[5];
      if (this.isoWaiter) {
        const w = this.isoWaiter;
        this.isoWaiter = null;
        w(size, pdu[5]);
        continue;
      }
      // Only the payload is returned
      const payload = new Uint8Array(pdu.subarray(TPKT_ISO.length));
      if (this.sslActive && this.tlsChannel) {
        // Data read is forwarded to TLS
        this.tlsChannel.feed(payload);
      } else {
        this.onDataReceived?.(payload, payload.length);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------------------------

  async send(buffer: Uint8Array): Promise<number> {
    if (!this.connected) {
      this._lastError = S7Consts.errTCPNotConnected;
      return this._lastError;
    }
    if (this.sslActive && this.tlsChannel) {
      try {
        await this.tlsChannel.write(buffer);
        this._lastError = 0;
      } catch {
        this._lastError = S7Consts.errTCPDataSend;
      }
      return this._lastError;
    }
    return this.sendIsoPacket(buffer);
  }

  private async sendPacket(buffer: Uint8Array): Promise<void> {
    if (this.connected) this._lastError = await this.socket.send(buffer, buffer.length);
    else this._lastError = S7Consts.errTCPNotConnected;
  }

  private async sendIsoPacket(buffer: Uint8Array): Promise<number> {
    // Wraps the data to be sent in the Iso header.
    const size = buffer.length;
    this._lastError = 0;
    if (size + TPKT_ISO.length > 0xffff) return S7Consts.errIsoInvalidPDU;
    const pdu = new Uint8Array(TPKT_ISO.length + size);
    pdu.set(TPKT_ISO, 0);
    this.setWordAt(pdu, 2, size + TPKT_ISO.length);
    pdu.set(buffer, TPKT_ISO.length);
    await this.sendPacket(pdu);
    return this._lastError;
  }

  private setWordAt(buffer: Uint8Array, pos: number, value: number): void {
    buffer[pos] = (value >> 8) & 0xff;
    buffer[pos + 1] = value & 0xff;
  }

  // ---------------------------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------------------------

  private async isoConnect(): Promise<number> {
    const rt = this.remoteTSAP_S;
    const isocr = Uint8Array.from(ISO_CR_HEAD);
    isocr[16] = this.localTSAP_HI;
    isocr[17] = this.localTSAP_LO;
    isocr[3] = (20 + rt.length) & 0xff;
    isocr[4] = (15 + rt.length) & 0xff;
    isocr[19] = rt.length & 0xff;
    const isocon = new Uint8Array(isocr.length + rt.length);
    isocon.set(isocr, 0);
    isocon.set(rt, isocr.length);

    // Sets up the waiter for the reply before sending
    const reply = new Promise<{ size: number; type: number } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.isoWaiter = null;
        this.isoWaitAbort = null;
        resolve(null);
      }, this._RecvTimeout);
      this.isoWaiter = (size, type) => {
        clearTimeout(timer);
        this.isoWaitAbort = null;
        resolve({ size, type });
      };
      this.isoWaitAbort = () => {
        clearTimeout(timer);
        this.isoWaiter = null;
        this.isoWaitAbort = null;
        resolve(null);
      };
    });
    // Sends the connection request telegram
    await this.sendPacket(isocon);
    if (this._lastError !== 0) {
      this.isoWaiter = null;
      this.isoWaitAbort = null;
      return this._lastError;
    }
    // Gets the reply (if any)
    const r = await reply;
    if (r === null) {
      this._lastError = S7Consts.errTCPDataReceive;
    } else if (r.size === 36) {
      if (r.type !== 0xd0) this._lastError = S7Consts.errIsoConnect; // 0xD0 = CC Connection confirm
    } else {
      this._lastError = S7Consts.errIsoInvalidPDU;
    }
    return this._lastError;
  }

  async connect(): Promise<number> {
    this._lastError = 0;
    this.time_ms = 0;
    const elapsed = Date.now();
    if (!this.connected) {
      this.socket.close();
      this.socket = this.createSocket();
      this.rxBuf = Buffer.alloc(0);
      this.dateTimeStarted = new Date();
      // First stage : TCP Connection
      this._lastError = await this.socket.connect(this.ipAddress, this._PLCPort);
      if (this._lastError === 0) {
        // Second stage : ISOTCP (ISO 8073) Connection
        await this.isoConnect();
      }
    }
    if (this._lastError !== 0) this.disconnect();
    else this.time_ms = Date.now() - elapsed;
    return this._lastError;
  }

  setConnectionParams(address: string, localTSAP: number, remoteTSAP: Uint8Array): number {
    const locTSAP = localTSAP & 0x0000ffff;
    this.ipAddress = address;
    this.localTSAP_HI = locTSAP >> 8;
    this.localTSAP_LO = locTSAP & 0x00ff;
    this.remoteTSAP_S = Uint8Array.from(remoteTSAP);
    return 0;
  }

  disconnect(): number {
    this.isoWaiter = null;
    this.sslActive = false;
    this.tlsChannel?.close();
    this.tlsChannel = null;
    this.tlsHandshake = null;
    this.socket.close();
    return 0;
  }

  getParam(paramNumber: number): { res: number; value: number } {
    switch (paramNumber) {
      case S7Consts.p_u16_RemotePort:
        return { res: 0, value: this.plcPort };
      case S7Consts.p_i32_PingTimeout:
        return { res: 0, value: this.connTimeout };
      case S7Consts.p_i32_SendTimeout:
        return { res: 0, value: this.sendTimeout };
      case S7Consts.p_i32_RecvTimeout:
        return { res: 0, value: this.recvTimeout };
      case S7Consts.p_i32_PDURequest:
        return { res: 0, value: this.pduSizeRequested };
      default:
        return { res: S7Consts.errCliInvalidParamNumber, value: 0 };
    }
  }

  // Set Properties for compatibility with Snap7.net.cs
  setParam(paramNumber: number, value: number): number {
    switch (paramNumber) {
      case S7Consts.p_u16_RemotePort:
        this.plcPort = value;
        return 0;
      case S7Consts.p_i32_PingTimeout:
        this.connTimeout = value;
        return 0;
      case S7Consts.p_i32_SendTimeout:
        this.sendTimeout = value;
        return 0;
      case S7Consts.p_i32_RecvTimeout:
        this.recvTimeout = value;
        return 0;
      case S7Consts.p_i32_PDURequest:
        this.pduSizeRequested = value;
        return 0;
      default:
        return S7Consts.errCliInvalidParamNumber;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Info Functions / Properties
  // ---------------------------------------------------------------------------------------------

  static errorText(error: number): string {
    switch (error) {
      case 0:
        return "OK";
      case S7Consts.errTCPSocketCreation:
        return "SYS : Error creating the Socket";
      case S7Consts.errTCPConnectionTimeout:
        return "TCP : Connection Timeout";
      case S7Consts.errTCPConnectionFailed:
        return "TCP : Connection Error";
      case S7Consts.errTCPReceiveTimeout:
        return "TCP : Data receive Timeout";
      case S7Consts.errTCPDataReceive:
        return "TCP : Error receiving Data";
      case S7Consts.errTCPSendTimeout:
        return "TCP : Data send Timeout";
      case S7Consts.errTCPDataSend:
        return "TCP : Error sending Data";
      case S7Consts.errTCPConnectionReset:
        return "TCP : Connection reset by the Peer";
      case S7Consts.errTCPNotConnected:
        return "CLI : Client not connected";
      case S7Consts.errTCPUnreachableHost:
        return "TCP : Unreachable host";
      case S7Consts.errIsoConnect:
        return "ISO : Connection Error";
      case S7Consts.errIsoInvalidPDU:
        return "ISO : Invalid PDU received";
      case S7Consts.errIsoInvalidDataSize:
        return "ISO : Invalid Buffer passed to Send/Receive";
      case S7Consts.errCliNegotiatingPDU:
        return "CLI : Error in PDU negotiation";
      case S7Consts.errCliInvalidParams:
        return "CLI : invalid param(s) supplied";
      case S7Consts.errCliJobPending:
        return "CLI : Job pending";
      case S7Consts.errCliTooManyItems:
        return "CLI : too may items (>20) in multi read/write";
      case S7Consts.errCliInvalidWordLen:
        return "CLI : invalid WordLength";
      case S7Consts.errCliPartialDataWritten:
        return "CLI : Partial data written";
      case S7Consts.errCliSizeOverPDU:
        return "CPU : total data exceeds the PDU size";
      case S7Consts.errCliInvalidPlcAnswer:
        return "CLI : invalid CPU answer";
      case S7Consts.errCliAddressOutOfRange:
        return "CPU : Address out of range";
      case S7Consts.errCliInvalidTransportSize:
        return "CPU : Invalid Transport size";
      case S7Consts.errCliWriteDataSizeMismatch:
        return "CPU : Data size mismatch";
      case S7Consts.errCliItemNotAvailable:
        return "CPU : Item not available";
      case S7Consts.errCliInvalidValue:
        return "CPU : Invalid value supplied";
      case S7Consts.errCliCannotStartPLC:
        return "CPU : Cannot start PLC";
      case S7Consts.errCliAlreadyRun:
        return "CPU : PLC already RUN";
      case S7Consts.errCliCannotStopPLC:
        return "CPU : Cannot stop PLC";
      case S7Consts.errCliCannotCopyRamToRom:
        return "CPU : Cannot copy RAM to ROM";
      case S7Consts.errCliCannotCompress:
        return "CPU : Cannot compress";
      case S7Consts.errCliAlreadyStop:
        return "CPU : PLC already STOP";
      case S7Consts.errCliFunNotAvailable:
        return "CPU : Function not available";
      case S7Consts.errCliUploadSequenceFailed:
        return "CPU : Upload sequence failed";
      case S7Consts.errCliInvalidDataSizeRecvd:
        return "CLI : Invalid data size received";
      case S7Consts.errCliInvalidBlockType:
        return "CLI : Invalid block type";
      case S7Consts.errCliInvalidBlockNumber:
        return "CLI : Invalid block number";
      case S7Consts.errCliInvalidBlockSize:
        return "CLI : Invalid block size";
      case S7Consts.errCliNeedPassword:
        return "CPU : Function not authorized for current protection level";
      case S7Consts.errCliInvalidPassword:
        return "CPU : Invalid password";
      case S7Consts.errCliAccessDenied:
        return "CPU : Access denied";
      case S7Consts.errCliNoPasswordToSetOrClear:
        return "CPU : No password to set or clear";
      case S7Consts.errCliJobTimeout:
        return "CLI : Job Timeout";
      case S7Consts.errCliFunctionRefused:
        return "CLI : function refused by CPU (Unknown error)";
      case S7Consts.errCliPartialDataRead:
        return "CLI : Partial data read";
      case S7Consts.errCliBufferTooSmall:
        return "CLI : The buffer supplied is too small to accomplish the operation";
      case S7Consts.errCliDestroying:
        return "CLI : Cannot perform (destroying)";
      case S7Consts.errCliInvalidParamNumber:
        return "CLI : Invalid Param Number";
      case S7Consts.errCliCannotChangeParam:
        return "CLI : Cannot change this param now";
      case S7Consts.errCliFunctionNotImplemented:
        return "CLI : Function not implemented";
      case S7Consts.errCliFirmwareNotSupported:
        return "CLI : Firmware not supported";
      case S7Consts.errCliDeviceNotSupported:
        return "CLI : Device type not supported";
      default:
        return "CLI : Unknown error (0x" + error.toString(16) + ")";
    }
  }

  lastError(): number {
    return this._lastError;
  }
  requestedPduLength(): number {
    return this._PduSizeRequested;
  }
  negotiatedPduLength(): number {
    return this._PDULength;
  }
  execTime(): number {
    return this.time_ms;
  }
  get executionTime(): number {
    return this.time_ms;
  }
  get pduSizeNegotiated(): number {
    return this._PDULength;
  }
  get pduSizeRequested(): number {
    return this._PduSizeRequested;
  }
  set pduSizeRequested(value: number) {
    if (value < MinPduSizeToRequest) value = MinPduSizeToRequest;
    if (value > MaxPduSizeToRequest) value = MaxPduSizeToRequest;
    this._PduSizeRequested = value;
  }
  get plcPort(): number {
    return this._PLCPort;
  }
  set plcPort(v: number) {
    this._PLCPort = v;
  }
  get connTimeout(): number {
    return this._ConnTimeout;
  }
  set connTimeout(v: number) {
    this._ConnTimeout = v;
    this.socket.connectTimeout = v;
  }
  get recvTimeout(): number {
    return this._RecvTimeout;
  }
  set recvTimeout(v: number) {
    this._RecvTimeout = v;
    this.socket.readTimeout = v;
  }
  get sendTimeout(): number {
    return this._SendTimeout;
  }
  set sendTimeout(v: number) {
    this._SendTimeout = v;
    this.socket.writeTimeout = v;
  }
  get connected(): boolean {
    return this.socket.connected;
  }
}
