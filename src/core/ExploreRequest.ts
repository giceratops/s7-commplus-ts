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
import { ValueStruct } from "./PValue.js";

export class ExploreRequest {
  transportFlags = 0x34; // or 0x36???
  exploreId = 0;
  exploreRequestId = 0;
  exploreChildsRecursive = 0;
  exploreParents = 0;
  filterData: ValueStruct | null = null;
  addressList: number[] = [];
  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.Explore;
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
    ret += S7p.encodeUInt32(buffer, this.exploreId);
    ret += S7p.encodeUInt32Vlq(buffer, this.exploreRequestId);
    ret += S7p.encodeByte(buffer, this.exploreChildsRecursive);
    ret += S7p.encodeByte(buffer, 1); // unknown 0 or 1?
    ret += S7p.encodeByte(buffer, this.exploreParents);
    if (this.filterData !== null) {
      ret += S7p.encodeByte(buffer, 1); // 1 object / value
      // TODO / Experimental:
      // Not 100% sure about how this has to be used:
      // On a Struct, we don't write the datatypeflags into the stream.
      // Maybe the byte before are the flags (which is the way I have it in the Wireshark dissector so far, which may be wrong).
      // To get this working, the byte which gas given the number of addresses isn't written to the stream anymore.
      // ret += S7p.encodeByte(buffer, 0); // 0 address
      ret += this.filterData.serialize(buffer);
    }
    ret += S7p.encodeByte(buffer, 0); // Number of following Objects / unknown
    ret += S7p.encodeUInt32Vlq(buffer, this.addressList.length >>> 0); // in Wireshark Dissector only 1 Byte, but maybe a VLQ
    for (const id of this.addressList) {
      ret += S7p.encodeUInt32Vlq(buffer, id);
    }
    if (this.withIntegrityId) {
      ret += S7p.encodeUInt32Vlq(buffer, this.integrityId);
    }
    // Fill?
    ret += S7p.encodeUInt32(buffer, 0);
    // Plcsim V13 with Integrity Id needs here 5 Bytes, with 4 doesn't work (not responding).
    // But with my old 1200er FW2.2 it's still working with 4.
    ret += S7p.encodeByte(buffer, 0);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<ExploreRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<RequestSet>" + "\n";
    s += "<ExploreId>" + this.exploreId.toString() + "</ExploreId>" + "\n";
    s += "<ExploreRequestId>" + this.exploreRequestId.toString() + "</ExploreRequestId>" + "\n";
    s += "<ExploreChildsRecursive>" + this.exploreChildsRecursive.toString() + "</ExploreChildsRecursive>" + "\n";
    s += "<ExploreParents>" + this.exploreParents.toString() + "</ExploreParents>" + "\n";
    s += "<AddressList>" + "\n";
    for (const id of this.addressList) {
      s += "<Id>" + id.toString() + "</Id>";
    }
    s += "</AddressList>" + "\n";
    s += "</RequestSet>" + "\n";
    s += "</ExploreRequest>" + "\n";
    return s;
  }
}
