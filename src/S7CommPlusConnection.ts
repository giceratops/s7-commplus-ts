/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * This file is part of S7CommPlusDriver. Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 *
 * The C# class is a `partial class`; the legitimation / alarming / subscription pieces were ported as standalone
 * functions/classes taking the connection. This class exposes the members they need (client, sessionId,
 * sessionId2, readTimeout, lastError, receivedPDU, omsSecret, sendS7plusFunctionObject, waitForNewS7plusReceived,
 * checkResponseWithIntegrity, subscriptionSetCreditLimit, deleteObject) and delegating convenience methods.
 *
 * Concurrency: the C# driver is effectively one request at a time. Public request methods serialise through a
 * simple async lock (`withRequestLock`). waitForNewS7plusReceived waits on a Promise that is resolved by the
 * receive handler instead of polling with a mutex.
 */
import { ByteStream } from "./core/ByteStream.js";
import { Ids } from "./core/Ids.js";
import { Functioncode } from "./core/Functioncode.js";
import { ProtocolVersion } from "./core/ProtocolVersion.js";
import { Softdatatype } from "./core/Softdatatype.js";
import { CommRessources } from "./core/CommRessources.js";
import { BlobDecompressor } from "./core/BlobDecompressor.js";
import { SystemEvent } from "./core/SystemEvent.js";
import { InitSslRequest } from "./core/InitSslRequest.js";
import { InitSslResponse } from "./core/InitSslResponse.js";
import { CreateObjectRequest } from "./core/CreateObjectRequest.js";
import { CreateObjectResponse } from "./core/CreateObjectResponse.js";
import { SetMultiVariablesRequest } from "./core/SetMultiVariablesRequest.js";
import { SetMultiVariablesResponse } from "./core/SetMultiVariablesResponse.js";
import { GetMultiVariablesRequest } from "./core/GetMultiVariablesRequest.js";
import { GetMultiVariablesResponse } from "./core/GetMultiVariablesResponse.js";
import { SetVariableRequest } from "./core/SetVariableRequest.js";
import { SetVariableResponse } from "./core/SetVariableResponse.js";
import { DeleteObjectRequest } from "./core/DeleteObjectRequest.js";
import { DeleteObjectResponse } from "./core/DeleteObjectResponse.js";
import { ExploreRequest } from "./core/ExploreRequest.js";
import { ExploreResponse } from "./core/ExploreResponse.js";
import type { IS7pRequest } from "./core/IS7pRequest.js";
import type { IS7pResponse } from "./core/IS7pResponse.js";
import type { PObject } from "./core/PObject.js";
import type { PVartypeListElement } from "./core/PVartypeList.js";
import type { IOffsetInfoType_1Dim, IOffsetInfoType_MDim, IOffsetInfoType_Relation } from "./core/POffsetInfoType.js";
import {
  ValueBlobSparseArray,
  ValueDInt,
  ValueRID,
  ValueStruct,
  ValueUDInt,
  ValueUDIntArray,
  ValueWString,
  ValueWStringSparseArray,
} from "./core/PValue.js";
import type { PValue } from "./core/PValue.js";
import { S7Client } from "./net/S7Client.js";
import { S7Consts } from "./net/S7Consts.js";
import { Browser, VarInfo, eNodeType } from "./clientapi/Browser.js";
import { ItemAddress } from "./clientapi/ItemAddress.js";
import type { PlcTag } from "./clientapi/PlcTag.js";
import { PlcTags } from "./clientapi/PlcTags.js";
import * as Legitimation from "./legitimation/Legitimation.js";
import { AlarmsHandler } from "./alarming/AlarmsHandler.js";
import * as BrowseAlarms from "./alarming/BrowseAlarms.js";
import type { AlarmData } from "./alarming/BrowseAlarms.js";
import type { AlarmsDai } from "./alarming/AlarmsDai.js";
import { Subscription, asSubscriptionConnection } from "./subscriptions/Subscription.js";

export class BrowseEntry {
  name = "";
  softdatatype = 0;
  lid = 0;
  symbolCrc = 0;
  accessSequence = "";
}

export class BrowseData {
  db_name = ""; // Name of the datablock
  db_number = 0; // Number of the datablock
  db_block_relid = 0; // RID of the datablock
  db_block_ti_relid = 0; // Type-Info RID of the datablock
  variables: BrowseEntry[] = []; // Variables inside the datablock
}

export class DatablockInfo {
  db_name = ""; // Name of the datablock
  db_number = 0; // Number of the datablock
  db_block_relid = 0; // RID of the datablock
  db_block_ti_relid = 0; // Type-Info RID of the datablock
}

const hex = (n: number): string => (n >>> 0).toString(16).toUpperCase();
const hex4 = (n: number): string => hex(n).padStart(4, "0");

function first<T>(arr: T[], pred: (o: T) => boolean): T {
  const r = arr.find(pred);
  if (r === undefined) throw new Error("Sequence contains no matching element");
  return r;
}

export class S7CommPlusConnection {
  client!: S7Client; // m_client
  receivedPDU: ByteStream = new ByteStream(); // m_ReceivedPDU
  sessionId = 0; // m_SessionId
  private _sessionId2 = 0; // m_SessionId2
  readTimeout = 5000; // m_ReadTimeout
  /**
   * TypeScript addition (the C# driver always uses ISO-on-TCP port 102 and the default socket timeouts):
   * TCP port, TCP connect timeout and ISO connection-confirm receive timeout (ms) used by connect().
   * Useful for PLC simulators, port forwards and the in-process mock PLC of the integration tests.
   */
  plcPort = 102;
  connTimeout = 2000;
  isoRecvTimeout = 2000;
  lastError = 0; // m_LastError
  /** OMS secret, rolled by legitimateNew. */
  omsSecret: Uint8Array | null = null;

  private receivedTempPDU: ByteStream = new ByteStream();
  private receivedPDUs: ByteStream[] = [];
  private pduWaiters: Array<() => void> = [];
  private receivedNeedMoreDataForCompletePDU = false;
  private rxStream: Buffer = Buffer.alloc(0);
  private newS7CommPlusReceived = false;
  private sequenceNumber = 0;
  private integrityId = 0;
  private integrityIdSet = 0;
  private commRessources = new CommRessources();
  private dbInfoList: DatablockInfo[] | null = null;
  private typeInfoList: PObject[] = [];
  private lockTail: Promise<void> = Promise.resolve();
  private _alarmsHandler: AlarmsHandler | null = null;
  private _subscription: Subscription | null = null;

  get sessionId2(): number {
    return this._sessionId2;
  }

  /** Limits of the PLC (read during connect). */
  get commResources(): CommRessources {
    return this.commRessources;
  }

  /** Handler for alarm subscriptions (C# partial class AlarmsHandler.cs). */
  get alarmsHandler(): AlarmsHandler {
    if (this._alarmsHandler === null) this._alarmsHandler = new AlarmsHandler(BrowseAlarms.asAlarmConnection(this));
    return this._alarmsHandler;
  }

  /** Handler for variable subscriptions (C# partial class Subscription.cs). */
  get subscription(): Subscription {
    if (this._subscription === null) this._subscription = new Subscription(asSubscriptionConnection(this));
    return this._subscription;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Request serialisation
  // ------------------------------------------------------------------------------------------------------------

  /** Runs fn exclusively: only one request/response exchange at a time (not re-entrant). */
  withRequestLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(fn, fn);
    this.lockTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------------------------------------------

  private getNextSequenceNumber(): number {
    if (this.sequenceNumber === 0xffff) {
      this.sequenceNumber = 1;
    } else {
      this.sequenceNumber++;
    }
    return this.sequenceNumber;
  }

  // We must count the IntegrityId for different functions of the protocol.
  // As a first guess functions for setting variables need separate counters.
  // Use the functioncode to differ between the which sequence/integrity counter values.
  private getNextIntegrityId(functioncode: number): number {
    switch (functioncode) {
      case Functioncode.SetMultiVariables:
      case Functioncode.SetVariable:
      case Functioncode.SetVarSubStreamed:
      case Functioncode.DeleteObject:
      case Functioncode.CreateObject:
        this.integrityIdSet = this.integrityIdSet === 0xffffffff ? 0 : this.integrityIdSet + 1;
        return this.integrityIdSet;
      default:
        this.integrityId = this.integrityId === 0xffffffff ? 0 : this.integrityId + 1;
        return this.integrityId;
    }
  }

  /**
   * Waits until a new complete S7CommPlus PDU is available (it is then in receivedPDU) or the timeout expired
   * (then lastError = errTCPDataReceive).
   */
  waitForNewS7plusReceived(timeout: number): Promise<void> {
    const tryDequeue = (): boolean => {
      const pdu = this.receivedPDUs.shift();
      if (pdu !== undefined) {
        this.receivedPDU = pdu;
        return true;
      }
      return false;
    };
    if (tryDequeue()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (): void => {
        if (tryDequeue()) {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        } else {
          // Somebody else took the PDU, keep waiting
          this.pduWaiters.push(waiter);
        }
      };
      timer = setTimeout(() => {
        const i = this.pduWaiters.indexOf(waiter);
        if (i >= 0) this.pduWaiters.splice(i, 1);
        console.log("S7CommPlusConnection - WaitForNewS7plusReceived: ERROR: Timeout!");
        this.lastError = S7Consts.errTCPDataReceive;
        resolve();
      }, Math.max(0, timeout));
      this.pduWaiters.push(waiter);
    });
  }

  async sendS7plusFunctionObject(funcObj: IS7pRequest): Promise<number> {
    // If we don't have a SessionId, this must be the first CreateObjectRequest, where we use the Id for NullServerSession
    if (this.sessionId === 0) {
      funcObj.sessionId = Ids.ObjectNullServerSession;
    } else {
      funcObj.sessionId = this.sessionId;
    }

    // Insert SequenceNumber and IntegrityId, if neccessary for object type and state of communication
    funcObj.sequenceNumber = this.getNextSequenceNumber();
    if (funcObj.withIntegrityId) {
      funcObj.integrityId = this.getNextIntegrityId(funcObj.functionCode);
    }

    const stream = new ByteStream();
    funcObj.serialize(stream);
    return await this.sendS7plusPDUdata(stream.toArray(), stream.length, funcObj.protocolVersion);
  }

  private async sendS7plusPDUdata(sendPduData: Uint8Array, bytesToSend: number, protoVersion: number): Promise<number> {
    this.lastError = 0;

    let sourcePos = 0;
    const NegotiatedIsoPduSize = 1024; // TODO: Respect the negotiated TPDU size

    // 4 Byte TPKT Header
    // 3 Byte ISO-Header
    // 5 Byte TLS Header + 17 Bytes addition from TLS
    // 4 Byte S7CommPlus Header
    // 4 Byte S7CommPlus Trailer (must fit into last PDU)
    const MaxSize = NegotiatedIsoPduSize - 4 - 3 - 5 - 17 - 4 - 4;

    while (bytesToSend > 0) {
      let curSize: number;
      if (bytesToSend > MaxSize) {
        curSize = MaxSize;
        bytesToSend -= MaxSize;
      } else {
        curSize = bytesToSend;
        bytesToSend -= curSize;
      }
      const last = bytesToSend === 0;
      // Header + data (+ trailer only in last packet)
      const packet = new Uint8Array(4 + curSize + (last ? 4 : 0));
      packet[0] = 0x72;
      packet[1] = protoVersion;
      packet[2] = curSize >> 8;
      packet[3] = curSize & 0x00ff;
      packet.set(sendPduData.subarray(sourcePos, sourcePos + curSize), 4);
      sourcePos += curSize;
      let sendLen = 4 + curSize;
      if (last) {
        packet[sendLen++] = 0x72;
        packet[sendLen++] = protoVersion;
        packet[sendLen++] = 0;
        packet[sendLen++] = 0;
      }
      const r = await this.client.send(packet);
      if (r !== 0 && this.lastError === 0) this.lastError = r;
    }
    return this.lastError;
  }

  /**
   * TypeScript addition. The C# driver gets exactly one TLS record (OpenSSL SSL_read) or one TPDU per call and
   * relies on that in OnDataReceived (`len - 8 == dataLength` decides whether the trailer is present). Node's
   * TLSSocket does not guarantee that boundary (records may be coalesced or a fragment may be spread over several
   * 'data' events), so incoming bytes are first re-framed here into exactly what OnDataReceived expects: one S7+
   * fragment per call, header + data (+ 4 byte trailer when it is the last fragment). For input that is already
   * aligned the behaviour is identical.
   */
  private onDataReceived = (data: Uint8Array, _len: number): void => {
    this.rxStream = this.rxStream.length === 0 ? Buffer.from(data) : Buffer.concat([this.rxStream, data]);
    for (;;) {
      const b = this.rxStream;
      if (b.length < 4) return;
      if (b[0] !== 0x72) {
        // Not an S7CommPlus header: same reaction as OnDataReceived (error), a resynchronisation is impossible.
        this.rxStream = Buffer.alloc(0);
        this.receivedNeedMoreDataForCompletePDU = false;
        this.lastError = S7Consts.errIsoInvalidPDU;
        return;
      }
      const dataLen = (b[2] << 8) | b[3];
      let unitLen = 4 + dataLen;
      if (b[1] !== ProtocolVersion.SystemEvent && dataLen > 0) {
        // Is the fragment followed by the 4 byte trailer (72 ver 00 00)? Only the last fragment has one.
        if (b.length < unitLen + 4) return;
        if (b[unitLen] === 0x72 && b[unitLen + 1] === b[1] && b[unitLen + 2] === 0 && b[unitLen + 3] === 0) unitLen += 4;
      }
      if (b.length < unitLen) return;
      const unit = new Uint8Array(b.subarray(0, unitLen));
      this.rxStream = b.subarray(unitLen);
      try {
        this.onDataFragmentReceived(unit, unit.length);
      } catch (e) {
        // A malformed PDU (e.g. an undecodable SystemEvent) must not end up as an uncaught exception in the socket's
        // event handler, which would terminate the Node process (the C# receive thread has the same weakness).
        console.log("S7CommPlusConnection - OnDataReceived: Exception while processing a PDU: " + (e as Error).message);
        this.receivedNeedMoreDataForCompletePDU = false;
        this.newS7CommPlusReceived = false;
        this.lastError = S7Consts.errIsoInvalidPDU;
      }
    }
  };

  private onDataFragmentReceived(PDU: Uint8Array, len: number): void {
    // In this method, we've got always a complete TPDU (from protocol layer above) without fragmentation
    // At this point, we can detect if we receive a fragmented S7CommPlus PDU.
    // If not fragmented, then TPKT.Length - 15 is equal of the length in S7CommPlus.Header.
    // 15 bytes because: 4 Bytes TPKT.Header.len + 3 Bytes ISO.Header.Len + 4 Bytes S7CommPlus.Header.len + 4 Bytes S7CommPlus.trailer.Len.
    // Since the pure userdata of the TPDU comes in here, that is only minus 4 bytes header + 4 bytes trailer.
    //
    // Special handling for SystemEvents with ProtocolVersion = 0xfe:
    // Here's only a header.
    // Because of this, the first byte for the ProtocolVersion must be written in then stream at first.
    // The datalength must not be written into the stream, because it's not valid on fragmented PDUs
    // for the complete length, only for the single fragment.

    // If we use subscriptions or alarming, we may get new data before the last PDU was processed completely.
    // First step we push the complete PDU to a queue.

    if (!this.receivedNeedMoreDataForCompletePDU) {
      this.receivedTempPDU = new ByteStream();
    }
    let pos = 0;
    // Check header
    if (PDU[pos] !== 0x72) {
      this.receivedNeedMoreDataForCompletePDU = false;
      this.lastError = S7Consts.errIsoInvalidPDU;
      return;
    }
    pos++;
    const protoVersion = PDU[pos];
    if (
      protoVersion !== ProtocolVersion.V1 &&
      protoVersion !== ProtocolVersion.V2 &&
      protoVersion !== ProtocolVersion.V3 &&
      protoVersion !== ProtocolVersion.SystemEvent
    ) {
      this.receivedNeedMoreDataForCompletePDU = false;
      this.lastError = S7Consts.errIsoInvalidPDU;
      return;
    }
    // For the first fragment, write the ProtocolVersion into the stream in advance
    if (!this.receivedNeedMoreDataForCompletePDU) {
      this.receivedTempPDU.write(PDU, pos, 1);
    }
    pos++;

    // Read the length of the data-part from header
    const s7HeaderDataLen = (PDU[pos] << 8) | PDU[pos + 1];
    pos += 2;
    if (s7HeaderDataLen > 0) {
      // Special handling for SystemEvent 0xfe PDUs:
      // This only confirms a few data, but also reports major protocol errors (e.g. incorrect sequence numbers).
      // The confirms can be discarded (for now), but the errors are relevant, because a connection termination is neccessary.
      // As we don't have a trailer on this types, it's not possible that they are transmitted as fragments.
      if (protoVersion === ProtocolVersion.SystemEvent) {
        console.log("S7CommPlusConnection - OnDataReceived: ProtocolVersion 0xfe SystemEvent received");
        this.receivedTempPDU.write(PDU, pos, s7HeaderDataLen);
        pos += s7HeaderDataLen;
        // Create SystemEventObject
        this.receivedNeedMoreDataForCompletePDU = false;
        this.receivedTempPDU.position = 0;
        this.newS7CommPlusReceived = false;

        const sysevt = SystemEvent.deserializeFromPdu(this.receivedTempPDU);
        if (sysevt !== null && sysevt.isFatalError()) {
          console.log("S7CommPlusConnection - OnDataReceived: SystemEvent has fatal error");
          // Termination neccessary
          this.lastError = S7Consts.errIsoInvalidPDU;
        } else {
          console.log("S7CommPlusConnection - OnDataReceived: SystemEvent with non fatal error, do nothing");
        }
      } else {
        // Copy data part to destination stream
        this.receivedTempPDU.write(PDU, pos, s7HeaderDataLen);
        pos += s7HeaderDataLen;
        // If this is a fragmented PDU, then at this point no trailer
        if (len - 4 - 4 === s7HeaderDataLen) {
          this.receivedNeedMoreDataForCompletePDU = false;
          this.receivedTempPDU.position = 0; // Set position back to zero, ready for readout
          this.newS7CommPlusReceived = true;
        } else {
          this.receivedNeedMoreDataForCompletePDU = true;
        }
      }
    }

    // If a complete (usable) PDU is received, add to the queue for readout
    if (this.newS7CommPlusReceived) {
      this.receivedPDUs.push(this.receivedTempPDU);
      this.newS7CommPlusReceived = false;
      const w = this.pduWaiters.shift();
      if (w !== undefined) w();
    }
  }

  checkResponseWithIntegrity(request: IS7pRequest, response: IS7pResponse | null | undefined): number {
    if (response === null || response === undefined) {
      console.log("checkResponseWithIntegrity: ERROR! response == null");
      return S7Consts.errIsoInvalidPDU;
    }
    if (request.sequenceNumber !== response.sequenceNumber) {
      console.log(
        `checkResponseWithIntegrity: ERROR! SeqenceNumber of Response (${response.sequenceNumber}) doesn't match Request (${request.sequenceNumber})`,
      );
      return S7Consts.errIsoInvalidPDU;
    }
    // Overflow is possible and allowed
    const reqIntegCheck = (request.sequenceNumber + request.integrityId) >>> 0;
    if (response.integrityId !== reqIntegCheck) {
      console.log(
        `checkResponseWithIntegrity: ERROR! IntegrityId of the Response (${response.integrityId}) doesn't match Request (${reqIntegCheck})`,
      );
      // Don't return this as error so far
    }
    return 0;
  }

  /** Sends a request and waits for the response PDU (lastError is set on timeout / transport error). */
  private async sendAndWait(req: IS7pRequest): Promise<number> {
    const res = await this.sendS7plusFunctionObject(req);
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    return res;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Public methods
  // ------------------------------------------------------------------------------------------------------------

  /**
   * Establishes a connection to the PLC.
   * @param address PLC IP address
   * @param password PLC password (if set)
   * @param username PLC username (leave empty for legacy login)
   * @param timeoutMs read timeout in milliseconds (default: 5000 ms)
   * @returns 0 on success, else the error code
   */
  async connect(address: string, password = "", username = "", timeoutMs = 5000): Promise<number> {
    if (timeoutMs > 0) {
      this.readTimeout = timeoutMs;
    }

    this.lastError = 0;
    let res: number;
    const started = Date.now();
    // TypeScript addition: a connection object can be connected again (the C# class keeps this state, which breaks
    // a reconnect: sequence/integrity counters of the old session, a stale rolled OMS secret of the old TLS
    // session, type info of the old session and a SessionId left over by a failed attempt).
    this.sessionId = 0;
    this._sessionId2 = 0;
    this.sequenceNumber = 0;
    this.integrityId = 0;
    this.integrityIdSet = 0;
    this.omsSecret = null;
    this.dbInfoList = null;
    this.typeInfoList = [];
    this.commRessources = new CommRessources();
    this._subscription = null;
    this._alarmsHandler = null;
    this.rxStream = Buffer.alloc(0);
    this.client = new S7Client();
    this.client.onDataReceived = this.onDataReceived;
    this.client.plcPort = this.plcPort;
    this.client.connTimeout = this.connTimeout;
    this.client.recvTimeout = this.isoRecvTimeout;
    this.receivedPDUs = [];
    this.receivedNeedMoreDataForCompletePDU = false;
    this.newS7CommPlusReceived = false;

    this.client.setConnectionParams(address, 0x0600, new TextEncoder().encode("SIMATIC-ROOT-HMI"));
    res = await this.client.connect();
    if (res !== 0) return res;

    // Step 1: Unencrypted InitSSL Request / Response
    const sslReq = new InitSslRequest(ProtocolVersion.V1, 0, 0);
    res = await this.sendS7plusFunctionObject(sslReq);
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      this.client.disconnect();
      return this.lastError;
    }
    const sslRes = InitSslResponse.deserializeFromPdu(this.receivedPDU);
    if (sslRes === null) {
      console.log("S7CommPlusConnection - Connect: InitSslResponse with Error!");
      this.client.disconnect();
      // C# returns m_LastError here, which is 0 (= success) if the PLC answered with an unexpected PDU.
      return this.lastError !== 0 ? this.lastError : S7Consts.errIsoInvalidPDU;
    }

    // Step 2: Activate TLS. Everything from here onwards is TLS encrypted.
    res = await this.client.sslActivate();
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }

    // Step 3: CreateObjectRequest / Response (with TLS)
    const createObjReq = new CreateObjectRequest(ProtocolVersion.V1, 0, false);
    createObjReq.setNullServerSessionData();
    res = await this.sendS7plusFunctionObject(createObjReq);
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      this.client.disconnect();
      return this.lastError;
    }

    const createObjRes = CreateObjectResponse.deserializeFromPdu(this.receivedPDU);
    if (createObjRes === null) {
      console.log("S7CommPlusConnection - Connect: CreateObjectResponse with Error!");
      this.client.disconnect();
      return S7Consts.errIsoInvalidPDU;
    }
    // There are (always?) at least two IDs in the response.
    // Usually the first is used for polling data, and the 2nd for jobs which use notifications, e.g. alarming, subscriptions.
    this.sessionId = createObjRes.objectIds[0];
    this._sessionId2 = createObjRes.objectIds[1];
    console.log("S7CommPlusConnection - Connect: Using SessionId=0x" + hex4(this.sessionId));

    // Evaluate Struct 314
    const sval = createObjRes.responseObject!.getAttribute(Ids.ServerSessionVersion);
    const serverSession = sval as ValueStruct;

    // Step 4: SetMultiVariablesRequest / Response
    const setMultiVarReq = new SetMultiVariablesRequest(ProtocolVersion.V2);
    setMultiVarReq.setSessionSetupData(this.sessionId, serverSession);
    res = await this.sendS7plusFunctionObject(setMultiVarReq);
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      this.client.disconnect();
      return this.lastError;
    }

    const setMultiVarRes = SetMultiVariablesResponse.deserializeFromPdu(this.receivedPDU);
    if (setMultiVarRes === null) {
      console.log("S7CommPlusConnection - Connect: SetMultiVariablesResponse with Error!");
      this.client.disconnect();
      return S7Consts.errIsoInvalidPDU;
    }

    // Step 5: Read SystemLimits
    res = await this.commRessources.readMax(this);
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }

    // Step 6: Password
    res = await this.legitimate(serverSession, password, username);
    if (res !== 0) {
      this.client.disconnect();
      return res;
    }

    // If everything has been error-free up to this point, then the connection has been established successfully.
    console.log("S7CommPlusConnection - Connect: Time for connection establishment: " + (Date.now() - started) + " ms.");
    return 0;
  }

  async disconnect(): Promise<void> {
    // C# calls DeleteObject unconditionally (NullReferenceException when never connected, and a full read timeout
    // of waiting for an answer that cannot come when the connection is already gone / disconnect is called twice).
    if (this.client === undefined) return;
    if (this.client.connected && this.sessionId !== 0) {
      await this.deleteObject(this.sessionId);
    }
    this.client.disconnect();
  }

  /**
   * Deletes the object with the given Id.
   * @returns 0 on success
   */
  deleteObject(deleteObjectId: number): Promise<number> {
    return this.withRequestLock(() => this.deleteObjectInternal(deleteObjectId));
  }

  private async deleteObjectInternal(deleteObjectId: number): Promise<number> {
    let res: number;
    const delObjReq = new DeleteObjectRequest(ProtocolVersion.V2);
    delObjReq.deleteObjectId = deleteObjectId;
    res = await this.sendS7plusFunctionObject(delObjReq);
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      return this.lastError;
    }
    // If we delete our own session id, then there's no IntegrityId in the response.
    // And the error code gives an error, but not a fatal one.
    // If we delete another object, there should be an IntegrityId in the response, and
    // the response gives no error.
    if (deleteObjectId === this.sessionId) {
      DeleteObjectResponse.deserializeFromPdu(this.receivedPDU, false);
      // S7CommPlusConnection - DeleteSession: Deleted our own Session Id object, not checking the response.
      this.sessionId = 0; // not valid anymore
      this._sessionId2 = 0;
    } else {
      const delObjRes = DeleteObjectResponse.deserializeFromPdu(this.receivedPDU, true);
      res = this.checkResponseWithIntegrity(delObjReq, delObjRes);
      if (res !== 0) {
        return res;
      }
      if (delObjRes!.returnValue !== 0n) {
        console.log("S7CommPlusConnection - DeleteSession: Executed with Error! ReturnValue=" + delObjRes!.returnValue);
        res = -1;
      }
    }
    return res;
  }

  /**
   * Reads values. `values[i]` is null if the item could not be read; `errors[i]` is 0 on success
   * (0xffffffffffffffff if never set).
   */
  readValues(addresslist: ItemAddress[]): Promise<{ res: number; values: Array<PValue | null>; errors: bigint[] }> {
    return this.withRequestLock(() => this.readValuesInternal(addresslist));
  }

  private async readValuesInternal(
    addresslist: ItemAddress[],
  ): Promise<{ res: number; values: Array<PValue | null>; errors: bigint[] }> {
    // The requester must pass the internal type with the request, otherwise not all return values can be converted automatically.
    // For example, strings are transmitted as UInt-Array.
    const values: Array<PValue | null> = [];
    const errors: bigint[] = [];
    // Initialize error fields to error value
    for (let i = 0; i < addresslist.length; i++) {
      values.push(null);
      errors.push(0xffffffffffffffffn);
    }

    // Split request into chunks, taking the MaxTags per request into account
    let chunkStartIndex = 0;
    let countPerChunk = 0;
    do {
      let res: number;
      const getMultiVarReq = new GetMultiVariablesRequest(ProtocolVersion.V2);

      getMultiVarReq.addressList = [];
      countPerChunk = 0;
      while (countPerChunk < this.commRessources.tagsPerReadRequestMax && chunkStartIndex + countPerChunk < addresslist.length) {
        getMultiVarReq.addressList.push(addresslist[chunkStartIndex + countPerChunk]);
        countPerChunk++;
      }

      res = await this.sendS7plusFunctionObject(getMultiVarReq);
      if (res !== 0) {
        // C# ignores a failed send here and waits for the read timeout for an answer that cannot arrive
        // (WriteValues and all the other requests return the send error immediately).
        return { res, values, errors };
      }
      this.lastError = 0;
      await this.waitForNewS7plusReceived(this.readTimeout);
      if (this.lastError !== 0) {
        return { res: this.lastError, values, errors };
      }

      const getMultiVarRes = GetMultiVariablesResponse.deserializeFromPdu(this.receivedPDU);
      res = this.checkResponseWithIntegrity(getMultiVarReq, getMultiVarRes);
      if (res !== 0) {
        return { res, values, errors };
      }
      // ReturnValue shows also an error, if only one single variable could not be read
      if (getMultiVarRes!.returnValue !== 0n) {
        console.log("S7CommPlusConnection - ReadValues: Executed with Error! ReturnValue=" + getMultiVarRes!.returnValue);
      }

      // TODO: If a variable could not be read, there is no value, but there is an ErrorValue.
      // The user must therefore check whether Value != null. Maybe there's a more elegant solution.
      for (const [key, value] of getMultiVarRes!.values) {
        values[chunkStartIndex + key - 1] = value;
        // Initialize error to 0, will be overwritten below if there was an error on an item.
        errors[chunkStartIndex + key - 1] = 0n;
      }

      for (const [key, value] of getMultiVarRes!.errorValues) {
        errors[chunkStartIndex + key - 1] = value;
      }
      chunkStartIndex += countPerChunk;
    } while (chunkStartIndex < addresslist.length);

    return { res: this.lastError, values, errors };
  }

  writeValues(addresslist: ItemAddress[], values: PValue[]): Promise<{ res: number; errors: bigint[] }> {
    return this.withRequestLock(() => this.writeValuesInternal(addresslist, values));
  }

  private async writeValuesInternal(addresslist: ItemAddress[], values: PValue[]): Promise<{ res: number; errors: bigint[] }> {
    let res: number;
    const errors: bigint[] = [];
    for (let i = 0; i < addresslist.length; i++) {
      // Initialize to no error value, as there's no explicit value for write success.
      errors.push(0n);
    }

    // Split request into chunks, taking the MaxTags per request into account
    let chunkStartIndex = 0;
    let countPerChunk = 0;
    do {
      const setMultiVarReq = new SetMultiVariablesRequest(ProtocolVersion.V2);
      setMultiVarReq.addressListVar = [];
      setMultiVarReq.valueList = [];
      countPerChunk = 0;
      while (countPerChunk < this.commRessources.tagsPerWriteRequestMax && chunkStartIndex + countPerChunk < addresslist.length) {
        setMultiVarReq.addressListVar.push(addresslist[chunkStartIndex + countPerChunk]);
        setMultiVarReq.valueList.push(values[chunkStartIndex + countPerChunk]);
        countPerChunk++;
      }

      res = await this.sendS7plusFunctionObject(setMultiVarReq);
      if (res !== 0) {
        return { res, errors };
      }
      this.lastError = 0;
      await this.waitForNewS7plusReceived(this.readTimeout);
      if (this.lastError !== 0) {
        return { res: this.lastError, errors };
      }

      const setMultiVarRes = SetMultiVariablesResponse.deserializeFromPdu(this.receivedPDU);
      res = this.checkResponseWithIntegrity(setMultiVarReq, setMultiVarRes);
      if (res !== 0) {
        return { res, errors };
      }
      // ReturnValue shows also an error, if only one single variable could not be written
      if (setMultiVarRes!.returnValue !== 0n) {
        console.log("S7CommPlusConnection - WriteValues: Write with errors. ReturnValue=" + setMultiVarRes!.returnValue);
      }

      for (const [key, value] of setMultiVarRes!.errorValues) {
        errors[chunkStartIndex + key - 1] = value;
      }
      chunkStartIndex += countPerChunk;
    } while (chunkStartIndex < addresslist.length);

    return { res: this.lastError, errors };
  }

  /** Reads the given PlcTags (see PlcTags.readTags). */
  readTags(plcTags: Iterable<PlcTag>): Promise<number> {
    return PlcTags.readTags(this, plcTags);
  }

  /** Writes the given PlcTags (see PlcTags.writeTags). */
  writeTags(plcTags: Iterable<PlcTag>): Promise<number> {
    return PlcTags.writeTags(this, plcTags);
  }

  setPlcOperatingState(state: number): Promise<number> {
    return this.withRequestLock(async () => {
      let res: number;
      const setVarReq = new SetVariableRequest(ProtocolVersion.V2);
      setVarReq.inObjectId = Ids.NativeObjects_theCPUexecUnit_Rid;
      setVarReq.address = Ids.CPUexecUnit_operatingStateReq;
      setVarReq.value = new ValueDInt(state);

      res = await this.sendS7plusFunctionObject(setVarReq);
      if (res !== 0) {
        this.client.disconnect();
        return res;
      }
      this.lastError = 0;
      await this.waitForNewS7plusReceived(this.readTimeout);
      if (this.lastError !== 0) {
        this.client.disconnect();
        return this.lastError;
      }

      const setVarRes = SetVariableResponse.deserializeFromPdu(this.receivedPDU);
      if (setVarRes === null) {
        console.log("S7CommPlusConnection - Connect: SetVariableResponse with Error!");
        this.client.disconnect();
        return S7Consts.errIsoInvalidPDU;
      }
      return 0;
    });
  }

  browse(): Promise<{ res: number; varInfoList: VarInfo[] }> {
    return this.withRequestLock(() => this.browseInternal());
  }

  private async browseInternal(): Promise<{ res: number; varInfoList: VarInfo[] }> {
    let res: number;
    let varInfoList: VarInfo[] = [];
    const vars = new Browser();
    let exploreReq: ExploreRequest;
    let exploreRes: ExploreResponse | null;

    // Read all objects
    const exploreData: BrowseData[] = [];

    exploreReq = new ExploreRequest(ProtocolVersion.V2);
    exploreReq.exploreId = Ids.NativeObjects_thePLCProgram_Rid;
    exploreReq.exploreRequestId = Ids.None;
    exploreReq.exploreChildsRecursive = 1;
    exploreReq.exploreParents = 0;

    // We want to know the following attributes
    exploreReq.addressList.push(Ids.ObjectVariableTypeName);
    exploreReq.addressList.push(Ids.Block_BlockNumber);
    exploreReq.addressList.push(Ids.ASObjectES_Comment);

    res = await this.sendS7plusFunctionObject(exploreReq);
    if (res !== 0) {
      return { res, varInfoList };
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      return { res: this.lastError, varInfoList };
    }

    exploreRes = ExploreResponse.deserializeFromPdu(this.receivedPDU, true);
    res = this.checkResponseWithIntegrity(exploreReq, exploreRes);
    if (res !== 0) {
      return { res, varInfoList };
    }

    // Evaluate all data blocks that then need to be browsed
    const obj = first(exploreRes!.objects, (o) => o.classId === Ids.PLCProgram_Class_Rid);

    for (const ob of obj.getObjects()) {
      switch (ob.classId) {
        case Ids.DB_Class_Rid: {
          const relid = ob.relationId >>> 0;
          const area = relid >>> 16;
          const num = relid & 0xffff;
          if (area === 0x8a0e) {
            const name = ob.getAttribute(Ids.ObjectVariableTypeName) as ValueWString;
            const data = new BrowseData();
            data.db_block_relid = relid;
            data.db_name = name.getValue();
            data.db_number = num;
            exploreData.push(data);
          }
          break;
        }
      }
    }

    // Determine the TypeInfo RID to the RelId from the first response
    // By querying LID = 1 from all DBs you get the RID back with which the type information can be queried.
    // This is neccessary because, for example, with instance DBs (e.g. TON), the type information must
    // not be accessed via the RID of the DB, but of the RID of the TON.
    const readlist: ItemAddress[] = [];

    for (const data of exploreData) {
      if (data.db_number > 0) {
        // only process datablocks here, no marker, timer etc.
        // Insert the variable address
        const adr1 = new ItemAddress();
        adr1.accessArea = data.db_block_relid;
        adr1.accessSubArea = Ids.DB_ValueActual;
        adr1.lid.push(1);
        readlist.push(adr1);
      }
    }
    const rv = await this.readValuesInternal(readlist);
    res = rv.res;
    if (res !== 0) {
      return { res, varInfoList };
    }
    const values = rv.values;
    const errors = rv.errors;

    // Pass the preliminary information for recombination to ExploreSymbols

    // Add the response information to the list
    for (let i = 0; i < values.length; i++) {
      if (errors[i] === 0n) {
        const rid = values[i] as ValueRID;
        exploreData[i].db_block_ti_relid = rid.getValue();
      } else {
        // On error, set the relid to zero, will be removed from the list in the next step.
        // TODO: Report this as an error?
        exploreData[i].db_block_ti_relid = 0;
      }
    }
    // Remove elements with db_block_ti_relid == 0. This occurs e.g. on datablocks only present in load memory.
    // The informations can't be used any further (at least not for variable access).
    for (let i = exploreData.length - 1; i >= 0; i--) {
      if (exploreData[i].db_block_ti_relid === 0) exploreData.splice(i, 1);
    }

    for (const ed of exploreData) {
      vars.addBlockNode(eNodeType.Root, ed.db_name, ed.db_block_relid, ed.db_block_ti_relid);
    }

    // Add IQMCT areas manually
    vars.addBlockNode(eNodeType.Root, "IArea", Ids.NativeObjects_theIArea_Rid, 0x90010000);
    vars.addBlockNode(eNodeType.Root, "QArea", Ids.NativeObjects_theQArea_Rid, 0x90020000);
    vars.addBlockNode(eNodeType.Root, "MArea", Ids.NativeObjects_theMArea_Rid, 0x90030000);
    vars.addBlockNode(eNodeType.Root, "S7Timers", Ids.NativeObjects_theS7Timers_Rid, 0x90050000);
    vars.addBlockNode(eNodeType.Root, "S7Counters", Ids.NativeObjects_theS7Counters_Rid, 0x90060000);

    // Read the Type Info Container (as a single big PDU, must be proven to be the way to go in big programs)
    exploreReq = new ExploreRequest(ProtocolVersion.V2);
    // With ObjectOMSTypeInfoContainer we get all in a big PDU (with maybe hundreds of fragments)
    exploreReq.exploreId = Ids.ObjectOMSTypeInfoContainer;
    exploreReq.exploreRequestId = Ids.None;
    exploreReq.exploreChildsRecursive = 1;
    exploreReq.exploreParents = 0;

    res = await this.sendS7plusFunctionObject(exploreReq);
    if (res !== 0) {
      return { res, varInfoList };
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      return { res: this.lastError, varInfoList };
    }

    // Process the response, and build the complete variables list
    exploreRes = ExploreResponse.deserializeFromPdu(this.receivedPDU, true);
    res = this.checkResponseWithIntegrity(exploreReq, exploreRes);
    if (res !== 0) {
      return { res, varInfoList };
    }
    const objs = first(exploreRes!.objects, (o) => o.classId === Ids.ClassOMSTypeInfoContainer);

    vars.setTypeInfoContainerObjects(objs.getObjects());
    vars.buildTree();
    vars.buildFlatList();
    varInfoList = vars.getVarInfoList();

    return { res: 0, varInfoList };
  }

  /**
   * Gets the first level of a tag symbol string. Removes the " used to escape special chars.
   * `symbol.value` is updated to the remaining symbol (C# `ref string symbol`).
   * @throws Error Symbol syntax error
   */
  private parseSymbolLevel(symbol: { value: string }): string {
    const s = symbol.value;
    if (s.startsWith('"')) {
      const idx = s.indexOf('"', 1);
      if (idx < 0) throw new Error("Symbol syntax error");
      const lvl = s.substring(1, idx);
      let rest = s.substring(idx + 1);
      if (rest.startsWith(".")) rest = rest.substring(1);
      symbol.value = rest;
      return lvl;
    } else {
      let idx = s.indexOf(".");
      const idx2 = s.indexOf("[", 1);
      if (idx2 >= 0 && (idx2 < idx || idx < 0)) idx = idx2;
      if (idx >= 0) {
        const lvl = s.substring(0, idx);
        let rest = s.substring(idx);
        if (rest.startsWith(".")) rest = rest.substring(1);
        symbol.value = rest;
        return lvl;
      } else {
        symbol.value = "";
        return s;
      }
    }
  }

  /**
   * Gets the typeinfo by given ti relid from the internal buffer. If it's not found in the buffer
   * it's fetched from the PLC and stored in the buffer.
   * @throws Error Could not get type info
   */
  async getTypeInfoByRelId(tiRelId: number): Promise<PObject | undefined> {
    let pObj = this.typeInfoList.find((ti) => ti.relationId === tiRelId);
    if (pObj === undefined) {
      // Type info not found in list, request it from plc
      const r = await this.getTypeInformation(tiRelId);
      if (r.res !== 0) throw new Error("Could not get type info");
      this.typeInfoList.push(...r.objList);
      // Try again
      pObj = this.typeInfoList.find((ti) => ti.relationId === tiRelId);
    }
    return pObj;
  }

  /**
   * Calculates the access sequence for 1 dimensional arrays.
   * @throws Error Symbol syntax error, Out of bounds
   */
  private calcAccessSeqFor1DimArray(symbol: { value: string }, varType: PVartypeListElement, varInfo: VarInfo): void {
    const m = /^\[(-?\d+)\]/.exec(symbol.value);
    if (m === null) throw new Error("Symbol syntax error");
    this.parseSymbolLevel(symbol); // remove index from symbol string
    const arrayIndex = parseInt(m[1], 10);

    const ioit = varType.offsetInfoType as unknown as IOffsetInfoType_1Dim;
    const arrayElementCount = ioit.getArrayElementCount();
    const arrayLowerBounds = ioit.getArrayLowerBounds();

    if (arrayIndex - arrayLowerBounds > arrayElementCount) throw new Error("Out of bounds");
    if (arrayIndex < arrayLowerBounds) throw new Error("Out of bounds");
    varInfo.accessSequence += "." + hex(arrayIndex - arrayLowerBounds);
    if (varType.offsetInfoType!.hasRelation()) varInfo.accessSequence += ".1"; // additional ".1" for array of struct
  }

  /**
   * Calculates the access sequence for multi-dimensional arrays.
   * @throws Error Symbol syntax error, Out of bounds
   */
  private calcAccessSeqForMDimArray(symbol: { value: string }, varType: PVartypeListElement, varInfo: VarInfo): void {
    const m = /^\[( ?-?\d+ ?(, ?-?\d+ ?)+)\]/.exec(symbol.value);
    if (m === null) throw new Error("Symbol syntax error");
    this.parseSymbolLevel(symbol); // remove index from symbol string
    const idxs = m[1].replace(/ /g, "");

    const indexes = idxs.split(",").map((e) => parseInt(e, 10));
    const ioit = varType.offsetInfoType as unknown as IOffsetInfoType_MDim;
    const mdimArrayElementCount = [...ioit.getMdimArrayElementCount()];
    const mdimArrayLowerBounds = ioit.getMdimArrayLowerBounds() as unknown as number[];

    // check dim count
    const dimCount = mdimArrayElementCount.reduce((acc, act) => acc + (act > 0 ? 1 : 0), 0);
    if (dimCount !== indexes.length) throw new Error("Out of bounds");
    // check bounds
    for (let i = 0; i < dimCount; ++i) {
      indexes[i] = indexes[i] - mdimArrayLowerBounds[dimCount - i - 1];
      if (indexes[i] > mdimArrayElementCount[dimCount - i - 1]) throw new Error("Out of bounds");
      if (indexes[i] < 0) throw new Error("Out of bounds");
    }

    // calc dim size
    if (varType.softdatatype === Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL) {
      mdimArrayElementCount[0] += 8 - (mdimArrayElementCount[0] % 8); // for bool must be a mutiple of 8!
    }
    const dimSize: number[] = new Array<number>(dimCount).fill(0);
    let g = 1;
    for (let i = 0; i < dimCount - 1; ++i) {
      dimSize[i] = g;
      g *= mdimArrayElementCount[i];
    }
    dimSize[dimCount - 1] = g;

    // calc id
    let arrayIndex = 0;
    for (let i = 0; i < dimCount; ++i) {
      arrayIndex += indexes[i] * dimSize[dimCount - i - 1];
    }

    varInfo.accessSequence += "." + hex(arrayIndex);
    if (varType.offsetInfoType!.hasRelation()) varInfo.accessSequence += ".1"; // additional ".1" for array of struct
  }

  /**
   * Browses the symbol level by level recursively. Fetches missing type info automatically from the plc.
   * @returns plc tag or null if not found
   * @throws Error Symbol syntax error, Out of bounds
   */
  private async browsePlcTagBySymbol(tiRelId: number, symbol: { value: string }, varInfo: VarInfo): Promise<PlcTag | null> {
    const pObj = await this.getTypeInfoByRelId(tiRelId);
    if (pObj === undefined) throw new Error("Could not get type info");
    const levelName = this.parseSymbolLevel(symbol);
    // find level name of symbol in var list
    const idx = pObj.varnameList?.names?.indexOf(levelName) ?? -1;
    if (idx < 0) return null;
    const varType = pObj.vartypeList!.elements[idx];
    varInfo.accessSequence += "." + hex(varType.lid);
    let is1Dim = false;
    if (varType.offsetInfoType!.is1Dim()) {
      if (symbol.value === "") {
        is1Dim = true;
      } else {
        this.calcAccessSeqFor1DimArray(symbol, varType, varInfo);
      }
    }
    if (varType.offsetInfoType!.isMDim()) {
      this.calcAccessSeqForMDimArray(symbol, varType, varInfo);
    }
    if (varType.offsetInfoType!.hasRelation()) {
      if (symbol.value.length <= 0 && varType.softdatatype === Softdatatype.S7COMMP_SOFTDATATYPE_DTL) {
        return PlcTags.tagFactory(varInfo.name, new ItemAddress(varInfo.accessSequence), varType.softdatatype, is1Dim);
      }
      if (symbol.value.length <= 0) {
        return null;
      } else {
        const ioit = varType.offsetInfoType as unknown as IOffsetInfoType_Relation;
        return await this.browsePlcTagBySymbol(ioit.getRelationId(), symbol, varInfo);
      }
    } else {
      return PlcTags.tagFactory(varInfo.name, new ItemAddress(varInfo.accessSequence), varType.softdatatype, is1Dim);
    }
  }

  /**
   * Get the plc tag for the given plc tag symbol.
   * @returns plc tag, returns null if plc tag could not be found
   */
  async getPlcTagBySymbol(symbolStr: string): Promise<PlcTag | null> {
    const symbol = { value: symbolStr };
    const varInfo = new VarInfo();
    varInfo.name = symbolStr;
    // make sure we have the db list
    if (this.dbInfoList === null) {
      const r = await this.getListOfDatablocks();
      if (r.res !== 0) {
        return null;
      }
      this.dbInfoList = r.dbInfoList;
    }
    const levelName = this.parseSymbolLevel(symbol);
    // find db by first level name of symbol
    const dbInfo = this.dbInfoList.find((dbi) => dbi.db_name === levelName);
    if (dbInfo !== undefined) {
      varInfo.accessSequence = hex(dbInfo.db_block_relid);
      return await this.browsePlcTagBySymbol(dbInfo.db_block_ti_relid, symbol, varInfo);
    } else {
      symbol.value = varInfo.name;
      // Merker
      varInfo.accessSequence = hex(Ids.NativeObjects_theMArea_Rid);
      let tag = await this.browsePlcTagBySymbol(0x90030000, symbol, varInfo);
      if (tag !== null) return tag;
      symbol.value = varInfo.name;
      // Outputs
      varInfo.accessSequence = hex(Ids.NativeObjects_theQArea_Rid);
      tag = await this.browsePlcTagBySymbol(0x90020000, symbol, varInfo);
      if (tag !== null) return tag;
      symbol.value = varInfo.name;
      // Inputs
      varInfo.accessSequence = hex(Ids.NativeObjects_theIArea_Rid);
      tag = await this.browsePlcTagBySymbol(0x90010000, symbol, varInfo);
      if (tag !== null) return tag;
      // TODO: implement s5timers and counters... no one uses them anymore anyway
    }
    return null;
  }

  getListOfDatablocks(): Promise<{ res: number; dbInfoList: DatablockInfo[] }> {
    return this.withRequestLock(() => this.getListOfDatablocksInternal());
  }

  private async getListOfDatablocksInternal(): Promise<{ res: number; dbInfoList: DatablockInfo[] }> {
    let res: number;
    const dbInfoList: DatablockInfo[] = [];

    const exploreReq = new ExploreRequest(ProtocolVersion.V2);
    exploreReq.exploreId = Ids.NativeObjects_thePLCProgram_Rid;
    exploreReq.exploreRequestId = Ids.None;
    exploreReq.exploreChildsRecursive = 1;
    exploreReq.exploreParents = 0;

    // Add the attributes we need in the response
    exploreReq.addressList.push(Ids.ObjectVariableTypeName);

    // Set filter on Id for Datablock Class RID. With this filter, we only
    // get informations from datablocks, and not other blocks we don't need here.
    const filter = new ValueStruct(Ids.Filter);
    filter.addStructElement(Ids.FilterOperation, new ValueDInt(8)); // 8 = InstanceIOf
    filter.addStructElement(Ids.AddressCount, new ValueUDInt(0));
    const faddress: number[] = new Array<number>(32).fill(0); // Unknown, possible dependant on FilterOperation
    filter.addStructElement(Ids.Address, new ValueUDIntArray(faddress));
    filter.addStructElement(Ids.FilterValue, new ValueRID(Ids.DB_Class_Rid));

    exploreReq.filterData = filter;

    res = await this.sendS7plusFunctionObject(exploreReq);
    if (res !== 0) {
      return { res, dbInfoList };
    }
    this.lastError = 0;
    await this.waitForNewS7plusReceived(this.readTimeout);
    if (this.lastError !== 0) {
      return { res: this.lastError, dbInfoList };
    }

    const exploreRes = ExploreResponse.deserializeFromPdu(this.receivedPDU, true);
    res = this.checkResponseWithIntegrity(exploreReq, exploreRes);
    if (res !== 0) {
      return { res, dbInfoList };
    }

    // Get the datablock information we want further informations from.
    const objList = exploreRes!.objects;

    for (const ob of objList) {
      // May be this check can be removed, if setting the filter to the DB_Class_Rid is working 100%.
      switch (ob.classId) {
        case Ids.DB_Class_Rid: {
          const relid = ob.relationId >>> 0;
          const area = relid >>> 16;
          const num = relid & 0xffff;
          if (area === 0x8a0e) {
            const name = ob.getAttribute(Ids.ObjectVariableTypeName) as ValueWString;
            const data = new DatablockInfo();
            data.db_block_relid = relid;
            data.db_name = name.getValue();
            data.db_number = num;
            dbInfoList.push(data);
          }
          break;
        }
      }
    }

    // Get the TypeInfo RID to RelId from the first response

    // With LID=1 we get the RID back. With this number we can explore further
    // informations of this datablock.
    // This is neccessary, because informations about instance DBs (e.g. TON) you
    // don't get by the RID of the DB, instead of exploring the TON Type RID.
    const readlist: ItemAddress[] = [];

    for (const data of dbInfoList) {
      if (data.db_number > 0) {
        // Insert the address
        const adr1 = new ItemAddress();
        adr1.accessArea = data.db_block_relid;
        adr1.accessSubArea = Ids.DB_ValueActual;
        adr1.lid.push(1);
        readlist.push(adr1);
      }
    }
    const rv = await this.readValuesInternal(readlist);
    if (rv.res !== 0) {
      return { res: rv.res, dbInfoList };
    }

    // Insert response data into the list
    for (let i = 0; i < rv.values.length; i++) {
      if (rv.errors[i] === 0n) {
        const rid = rv.values[i] as ValueRID;
        dbInfoList[i].db_block_ti_relid = rid.getValue();
      } else {
        // On error, set relid=0, which is then removed in the next step.
        // Should we report this for the user?
        dbInfoList[i].db_block_ti_relid = 0;
      }
    }

    // Remove elements with db_block_ti_relid == 0.
    // This can occur on datablocks which are only in load memory and can't be explored.
    for (let i = dbInfoList.length - 1; i >= 0; i--) {
      if (dbInfoList[i].db_block_ti_relid === 0) dbInfoList.splice(i, 1);
    }

    return { res: 0, dbInfoList };
  }

  getTypeInformation(exploreId: number): Promise<{ res: number; objList: PObject[] }> {
    return this.withRequestLock(async () => {
      let res: number;
      let objList: PObject[] = [];

      const exploreReq = new ExploreRequest(ProtocolVersion.V2);
      exploreReq.exploreId = exploreId;
      exploreReq.exploreRequestId = Ids.None;
      exploreReq.exploreChildsRecursive = 1;
      exploreReq.exploreParents = 0;

      res = await this.sendS7plusFunctionObject(exploreReq);
      if (res !== 0) {
        return { res, objList };
      }
      this.lastError = 0;
      await this.waitForNewS7plusReceived(this.readTimeout);
      if (this.lastError !== 0) {
        return { res: this.lastError, objList };
      }

      const exploreRes = ExploreResponse.deserializeFromPdu(this.receivedPDU, true);
      res = this.checkResponseWithIntegrity(exploreReq, exploreRes);
      if (res !== 0) {
        return { res, objList };
      }
      objList = exploreRes!.objects;

      return { res: 0, objList };
    });
  }

  /**
   * Requests the tag and block comments from the Plc, returned as XML strings.
   * xmlLinecomment:
   * The returned XML format differs between between request of I/Q/M/C/T areas and datablocks:
   * I/Q/M/C/T: <CommentDictionary>     <TagLineComments>      <Comment RefID="ID"> <DictEntry Lanuage="de-DE"> ....
   * Datablock: <InterfaceLineComments> <Part Kind="Comments"> <Comment Path="ID">  <DictEntry Lanuage="de-DE"> ....
   * As "ID" the number for the variable identification is used.
   *
   * xmlDbcomment:
   * The xml-value description generated from our own value xml-serialization for WStringSparseArray. The value key is the language id.
   * Example:
   * <Value type ="WStringSparseArray"><Value key="1032">DB Kommentar in german de-DE</Value><Value key="1034">DB comment in english en-US</Value></Value>
   *
   * @param relid The relation ID for the area you want the comments for, e.g. 0x8a0e0000+db_number, or 0x52 for M-area
   */
  getCommentsXml(relid: number): Promise<{ res: number; xmlLinecomment: string; xmlDbcomment: string }> {
    return this.withRequestLock(async () => {
      let res: number;
      // With requesting DataInterface_InterfaceDescription, whe would be able to get all informations like the access ids and
      // datatype informations, that we get from the other browsing method. Needs to be tested which one is more efficient on network traffic or plc load.
      // If we keep use browsing for the comments, at least we would be able to read all information in one request.
      let xmlLinecomment = "";
      let xmlDbcomment = "";

      const exploreReq = new ExploreRequest(ProtocolVersion.V2);
      exploreReq.exploreId = relid;
      exploreReq.exploreRequestId = Ids.None;
      exploreReq.exploreChildsRecursive = 1;
      exploreReq.exploreParents = 0;

      // We want to know the following attributes
      exploreReq.addressList.push(Ids.ASObjectES_Comment);
      exploreReq.addressList.push(Ids.DataInterface_LineComments);

      res = await this.sendS7plusFunctionObject(exploreReq);
      if (res !== 0) {
        return { res, xmlLinecomment, xmlDbcomment };
      }
      this.lastError = 0;
      await this.waitForNewS7plusReceived(this.readTimeout);
      if (this.lastError !== 0) {
        return { res: this.lastError, xmlLinecomment, xmlDbcomment };
      }

      const exploreRes = ExploreResponse.deserializeFromPdu(this.receivedPDU, true);
      res = this.checkResponseWithIntegrity(exploreReq, exploreRes);
      if (res !== 0) {
        return { res, xmlLinecomment, xmlDbcomment };
      }

      for (const obj of exploreRes!.objects) {
        for (const [key, value] of obj.attributes) {
          switch (key) {
            case Ids.ASObjectES_Comment: {
              const attComment = value as ValueWStringSparseArray;
              xmlDbcomment = attComment.toString();
              break;
            }
            case Ids.DataInterface_LineComments: {
              const attLinecomment = value as ValueBlobSparseArray;
              const bd = new BlobDecompressor();
              const blobSp = attLinecomment.getValue();
              // In DBs we get the data with Sparsearray key = 1, in M-Area with key = 2.
              // For now, just take the first, don't know where the key ids are for.
              for (const blobKey of blobSp.keys()) {
                xmlLinecomment = bd.decompress(blobSp.get(blobKey)!.value!, 4); // Offset of 4, as we have a header for the zlib dictionary version
                break;
              }
              break;
            }
          }
        }
      }
      return { res: 0, xmlLinecomment, xmlDbcomment };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Legitimation.cs (partial class)
  // ------------------------------------------------------------------------------------------------------------

  /** Legitimation stage of the connect routine. @returns error code (0 = ok) */
  legitimate(serverSession: ValueStruct, password: string, username = ""): Promise<number> {
    return Legitimation.legitimate(this, serverSession, password, username);
  }

  legitimateNew(password: string, username = ""): Promise<number> {
    return Legitimation.legitimateNew(this, password, username);
  }

  legitimateLegacy(password: string): Promise<number> {
    return Legitimation.legitimateLegacy(this, password);
  }

  // ------------------------------------------------------------------------------------------------------------
  // BrowseAlarms.cs / AlarmsHandler.cs (partial class)
  // ------------------------------------------------------------------------------------------------------------

  /** Explores the AS and the User program alarms (see BrowseAlarms.exploreASAlarms). */
  exploreASAlarms(alarms: Map<bigint, AlarmData>, languageId: number): Promise<number> {
    return this.withRequestLock(() => BrowseAlarms.exploreASAlarms(BrowseAlarms.asAlarmConnection(this), alarms, languageId));
  }

  getActiveAlarms(languageId: number): Promise<{ res: number; alarmList: AlarmsDai[] }> {
    return this.withRequestLock(() => BrowseAlarms.getActiveAlarms(BrowseAlarms.asAlarmConnection(this), languageId));
  }

  alarmSubscriptionCreate(): Promise<number> {
    return this.alarmsHandler.alarmSubscriptionCreate();
  }

  testWaitForAlarmNotifications(waitTimeout: number, untilNumberOfAlarms: number, alarmTextsLanguageId: number): Promise<number> {
    return this.alarmsHandler.testWaitForAlarmNotifications(waitTimeout, untilNumberOfAlarms, alarmTextsLanguageId);
  }

  alarmSubscriptionDelete(): Promise<number> {
    return this.alarmsHandler.alarmSubscriptionDelete();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Subscription.cs (partial class)
  // ------------------------------------------------------------------------------------------------------------

  subscriptionCreate(plcTags: PlcTag[], cycleTime: number): Promise<number> {
    return this.subscription.subscriptionCreate(plcTags, cycleTime);
  }

  subscriptionSetCreditLimit(limit: number): Promise<number> {
    return this.subscription.subscriptionSetCreditLimit(limit);
  }

  testWaitForVariableChangeNotifications(untilNumberOfNotifications: number): Promise<number> {
    return this.subscription.testWaitForVariableChangeNotifications(untilNumberOfNotifications);
  }

  subscriptionDelete(): Promise<number> {
    return this.subscription.subscriptionDelete();
  }
}
