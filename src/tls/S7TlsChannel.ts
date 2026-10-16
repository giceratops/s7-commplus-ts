/*
 * S7CommPlusDriver - OpenSSLConnector replacement.
 * Ported to TypeScript: the OpenSSL memory-BIO connector is replaced by a Node `tls.TLSSocket`
 * running on top of a Duplex stream that is bridged to the COTP/ISO-on-TCP transport.
 */
import { Duplex } from "node:stream";
import * as tls from "node:tls";

export interface S7TlsChannelOptions {
  /** TLS wants to send bytes (handshake / encrypted records) to the peer (C# IConnectorCallback.WriteData). */
  writeData: (data: Uint8Array) => void;
  /** Decrypted application data is available (C# IConnectorCallback.OnDataAvailable). */
  onData: (data: Uint8Array) => void;
  /** Called for every TLS key log line (NSS format, includes trailing newline). Enables keylog if set. */
  onKeyLog?: (line: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export class S7TlsChannel {
  private readonly duplex: Duplex;
  private readonly sock: tls.TLSSocket;
  /** Resolves when the TLS handshake is complete, rejects on handshake failure. */
  readonly handshake: Promise<void>;

  constructor(opts: S7TlsChannelOptions) {
    this.duplex = new Duplex({
      write(chunk: Buffer, _enc, cb) {
        try {
          opts.writeData(new Uint8Array(chunk));
          cb();
        } catch (e) {
          cb(e as Error);
        }
      },
      read() {
        /* data is pushed by feed() */
      },
    });
    // TLS 1.3 is forced, because with TLS on top of IsoOnTCP the overhead of the encryption must be known
    // (for fragmenting S7CommPlus PDUs). With GCM there is no padding, the overhead is always 16 bytes.
    // TLS_CHACHA20_POLY1305_SHA256 is also a TLS 1.3 suite, so the allowed suites are set explicitly.
    this.sock = tls.connect({
      socket: this.duplex,
      minVersion: "TLSv1.3",
      ciphers: "TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256",
      rejectUnauthorized: false,
    });
    this.handshake = new Promise<void>((resolve, reject) => {
      this.sock.once("secureConnect", () => resolve());
      this.sock.once("error", (e) => reject(e));
      this.sock.once("close", () => reject(new Error("TLS closed before handshake completed")));
    });
    this.handshake.catch(() => {
      /* reported through onError */
    });
    this.sock.on("data", (d: Buffer) => opts.onData(new Uint8Array(d.buffer, d.byteOffset, d.length)));
    this.sock.on("error", (e) => opts.onError?.(e));
    this.sock.on("close", () => opts.onClose?.());
    if (opts.onKeyLog) {
      const cb = opts.onKeyLog;
      this.sock.on("keylog", (line: Buffer) => cb(line.toString("latin1")));
    }
  }

  /** Feed encrypted bytes received from the transport (C# ReadCompleted). */
  feed(data: Uint8Array): void {
    this.duplex.push(Buffer.from(data.buffer, data.byteOffset, data.length));
  }

  /** Encrypt and send application data. Writes before handshake completion are queued by Node. */
  write(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sock.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** SSL_export_keying_material replacement (no context). */
  exportKeyingMaterial(length: number, label: string, context?: Uint8Array): Uint8Array {
    const r = context
      ? this.sock.exportKeyingMaterial(length, label, Buffer.from(context))
      : this.sock.exportKeyingMaterial(length, label, undefined as unknown as Buffer);
    return new Uint8Array(r);
  }

  /** Create OMS exporter secret that is needed for the legitimation with the PLC */
  getOMSExporterSecret(): Uint8Array {
    return this.exportKeyingMaterial(32, "EXPERIMENTAL_OMS");
  }

  close(): void {
    this.sock.destroy();
    this.duplex.destroy();
  }
}
