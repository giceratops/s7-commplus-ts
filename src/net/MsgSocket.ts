/*
 * S7CommPlusDriver - Based on Snap7 (Sharp7.cs) by Davide Nardella, licensed under LGPL.
 * Ported to TypeScript (Node net.Socket based, push-style receive).
 */
import * as net from "node:net";
import { S7Consts } from "./S7Consts.js";

/**
 * Thin async wrapper around a Node TCP socket.
 * Instead of the blocking Receive() of the C# version, received bytes are pushed to `onData`.
 */
export class MsgSocket {
  private tcpSocket: net.Socket | null = null;
  readTimeout = 2000;
  writeTimeout = 2000;
  connectTimeout = 1000;
  lastError = 0;

  /** Called for every chunk of received bytes. */
  onData: ((data: Uint8Array) => void) | null = null;
  /** Called once when the connection was closed (by peer, error or close()). */
  onClose: ((hadError: boolean) => void) | null = null;

  get connected(): boolean {
    return this.tcpSocket !== null && !this.tcpSocket.destroyed && !this.tcpSocket.connecting;
  }

  close(): void {
    if (this.tcpSocket !== null) {
      const s = this.tcpSocket;
      this.tcpSocket = null;
      s.removeAllListeners("data");
      s.destroy();
    }
  }

  /** Returns 0 or an S7Consts error code. */
  connect(host: string, port: number): Promise<number> {
    this.lastError = 0;
    if (this.connected) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      const done = (err: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeListener("connect", onConnect);
        if (err !== 0) {
          sock.destroy();
          if (this.tcpSocket === sock) this.tcpSocket = null;
        }
        this.lastError = err;
        resolve(err);
      };
      const onConnect = () => {
        sock.on("data", (d: Buffer) => this.onData?.(new Uint8Array(d.buffer, d.byteOffset, d.length)));
        sock.on("error", () => {
          /* reported through close */
        });
        sock.on("close", (hadError) => {
          if (this.tcpSocket === sock) this.tcpSocket = null;
          this.onClose?.(hadError);
        });
        done(0);
      };
      const timer = setTimeout(() => done(S7Consts.errTCPConnectionFailed), this.connectTimeout);
      sock.once("connect", onConnect);
      sock.once("error", () => done(S7Consts.errTCPConnectionFailed));
      this.tcpSocket = sock;
      try {
        sock.connect({ host, port, family: 4 });
      } catch {
        done(S7Consts.errTCPConnectionFailed);
      }
    });
  }

  /** Returns 0 or an S7Consts error code. */
  send(buffer: Uint8Array, size: number = buffer.length): Promise<number> {
    this.lastError = 0;
    const sock = this.tcpSocket;
    if (sock === null) {
      this.lastError = S7Consts.errTCPNotConnected;
      return Promise.resolve(this.lastError);
    }
    return new Promise<number>((resolve) => {
      try {
        sock.write(buffer.subarray(0, size), (err) => {
          if (err) {
            this.lastError = S7Consts.errTCPDataSend;
            this.close();
          }
          resolve(this.lastError);
        });
      } catch {
        this.lastError = S7Consts.errTCPDataSend;
        this.close();
        resolve(this.lastError);
      }
    });
  }
}
