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
import { PValue } from "./PValue.js";

export class SetVariableRequest {
  transportFlags = 0x34;
  inObjectId = 0;
  address = 0;
  value!: PValue;
  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.SetVariable;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = true;

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
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
    // Request set
    ret += S7p.encodeUInt32(buffer, this.inObjectId);
    ret += S7p.encodeUInt32Vlq(buffer, 1); // Always 1 (?)
    ret += S7p.encodeUInt32Vlq(buffer, this.address);
    ret += this.value.serialize(buffer);
    ret += S7p.encodeObjectQualifier(buffer);
    // 1 Byte unknown
    ret += S7p.encodeByte(buffer, 0x00);
    if (this.withIntegrityId) {
      ret += S7p.encodeUInt32Vlq(buffer, this.integrityId);
    }
    // Fill?
    ret += S7p.encodeUInt32(buffer, 0);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<SetVariableRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<RequestSet>" + "\n";
    s += "<InObjectId>" + this.inObjectId.toString() + "</InObjectId>" + "\n";
    s += "<AddressList>" + "\n";
    s += "<Id>" + this.address.toString() + "</Id>" + "\n";
    s += "</AddressList>" + "\n";
    s += "<ValueList>" + "\n";
    s += "<Value>" + this.value.toString() + "</Value>" + "\n";
    s += "</ValueList>" + "\n";
    s += "</RequestSet>" + "\n";
    s += "</SetVariableRequest>" + "\n";
    return s;
  }
}
