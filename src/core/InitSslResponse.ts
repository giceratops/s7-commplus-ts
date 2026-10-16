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
import { PObject } from "./PObject.js";

export class InitSslResponse {
  transportFlags = 0;
  returnValue = 0n;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.InitSsl;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = false;

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
    this.withIntegrityId = false;
  }

  /** Returns the number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    this.sequenceNumber = S7p.decodeUInt16(buffer);
    this.transportFlags = S7p.decodeByte(buffer);
    // Response Set
    this.returnValue = S7p.decodeUInt64Vlq(buffer);
    if ((this.returnValue & 0x4000000000000000n) > 0n) {
      // Error Extension
      // Decode the error object, but don't use any informations from it. Must be processed on a higher level.
      S7p.decodeObject(buffer, new PObject());
    }
    return buffer.position - start;
  }

  toString(): string {
    let s = "";
    s += "<InitSslResponse>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<ResponseSet>" + "\n";
    s += "<ReturnValue>" + this.returnValue.toString() + "</ReturnValue>" + "\n";
    s += "</ResponseSet>" + "\n";
    s += "</InitSslResponse>" + "\n";
    return s;
  }

  static deserializeFromPdu(pdu: ByteStream): InitSslResponse | null {
    // Special handling of ProtocolVersion, which is written to the stream before
    const protocolVersion = S7p.decodeByte(pdu);
    const opcode = S7p.decodeByte(pdu);
    if (opcode !== Opcode.Response) {
      return null;
    }
    S7p.decodeUInt16(pdu); // reserved
    const fn = S7p.decodeUInt16(pdu);
    S7p.decodeUInt16(pdu); // reserved
    if (fn !== Functioncode.InitSsl) {
      return null;
    }
    const resp = new InitSslResponse(protocolVersion);
    resp.deserialize(pdu);
    return resp;
  }
}
