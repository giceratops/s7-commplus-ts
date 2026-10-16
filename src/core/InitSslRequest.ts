/**
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import { ByteStream } from "./ByteStream.js";
import { Functioncode } from "./Functioncode.js";
import { Opcode } from "./Opcode.js";
import { S7p } from "./S7p.js";

export class InitSslRequest {
  transportFlags = 0x30;

  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.InitSsl;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = false;

  constructor(protocolVersion: number, seqNum: number, sessionId: number) {
    this.protocolVersion = protocolVersion;
    this.sequenceNumber = seqNum;
    this.sessionId = sessionId;
    this.withIntegrityId = false;
  }

  getProtocolVersion(): number {
    return this.protocolVersion;
  }

  serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, Opcode.Request);
    ret += S7p.encodeUInt16(buffer, 0); // Reserved
    ret += S7p.encodeUInt16(buffer, this.functionCode);
    ret += S7p.encodeUInt16(buffer, 0); // Reserved
    ret += S7p.encodeUInt16(buffer, this.sequenceNumber);
    ret += S7p.encodeUInt32(buffer, this.sessionId);
    ret += S7p.encodeByte(buffer, this.transportFlags);
    // Fill?
    ret += S7p.encodeUInt32(buffer, 0);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<InitSslRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "</InitSslRequest>" + "\n";
    return s;
  }
}
