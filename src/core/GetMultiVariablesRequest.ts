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
import { ItemAddress } from "../clientapi/ItemAddress.js";

export class GetMultiVariablesRequest {
  transportFlags = 0x34;
  linkId = 0; // for reading variables, this should be 0
  addressList: ItemAddress[] = [];
  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.GetMultiVariables;
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
    let fieldCount = 0;
    // Request set
    ret += S7p.encodeUInt32(buffer, this.linkId);
    ret += S7p.encodeUInt32Vlq(buffer, this.addressList.length >>> 0);
    for (const adr of this.addressList) {
      fieldCount += adr.getNumberOfFields();
    }
    ret += S7p.encodeUInt32Vlq(buffer, fieldCount >>> 0);
    for (const adr of this.addressList) {
      ret += adr.serialize(buffer);
    }
    ret += S7p.encodeObjectQualifier(buffer);
    if (this.withIntegrityId) {
      ret += S7p.encodeUInt32Vlq(buffer, this.integrityId);
    }
    // Fill?
    ret += S7p.encodeUInt32(buffer, 0);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<GetMultiVariablesRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<RequestSet>" + "\n";
    s += "<LinkId>" + this.linkId.toString() + "</LinkId>" + "\n";
    s += "<ItemCount>" + this.addressList.length.toString() + "</ItemCount>" + "\n";
    let fieldCount = 0;
    for (const adr of this.addressList) {
      fieldCount += adr.getNumberOfFields();
    }
    s += "<NumberOfFields>" + fieldCount.toString() + "</NumberOfFields>" + "\n";
    s += "<AddressList>" + "\n";
    for (const adr of this.addressList) {
      s += adr.toString();
    }
    s += "</AddressList>" + "\n";
    s += "</RequestSet>" + "\n";
    s += "</GetMultiVariablesRequest>" + "\n";
    return s;
  }
}
