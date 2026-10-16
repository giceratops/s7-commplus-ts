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
import { Ids } from "./Ids.js";
import { PValue, ValueStruct } from "./PValue.js";

export class SetMultiVariablesRequest {
  transportFlags = 0x34;
  inObjectId = 0;
  /* Special
   * Plain variables are accessed with InObjectId = 0. Then the user needs to add
   * the addresses via the addresslist and the valuelist the values which should be written.
   * The field after Itemcount then doesn't contains the number of addresses, but the number
   * of field inside it.
   * Which is in the normal use case:
   * 1. SymbolCRC (maybe zero of not CRC check is needed)
   * 2. Access base-area
   * 3. Number of fields which are now following
   * Depending on the address this if
   *
   * If values inside objects are to be written, then the addresslist contains only a single value.
   * But counting them is identically.
   *
   * The only misleading thing is, we have two addresslists as members for both use-cases.
   * TODO
   */
  addressList: number[] = [];
  addressListVar: ItemAddress[] = [];
  valueList: PValue[] = [];
  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.SetMultiVariables;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = true;

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
  }

  setSessionSetupData(sessionId: number, sessionVersion: ValueStruct): void {
    // Initializes some values for session setup. Depending on the CPU, some more values needs to be set.
    this.sessionId = sessionId;
    this.inObjectId = sessionId;
    this.addressList.length = 0;
    this.addressList.push(Ids.ServerSessionVersion);
    this.valueList.length = 0;
    this.valueList.push(sessionVersion);
    // As we use her ProtocolVersion 2, without
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
    // Request set
    ret += S7p.encodeUInt32(buffer, this.inObjectId);
    ret += S7p.encodeUInt32Vlq(buffer, this.valueList.length >>> 0);
    if (this.inObjectId > 0) {
      ret += S7p.encodeUInt32Vlq(buffer, this.addressList.length >>> 0);
      for (const id of this.addressList) {
        ret += S7p.encodeUInt32Vlq(buffer, id);
      }
    } else {
      let fieldCount = 0;
      for (const adr of this.addressListVar) {
        fieldCount += adr.getNumberOfFields();
      }
      ret += S7p.encodeUInt32Vlq(buffer, fieldCount >>> 0);
      for (const adr of this.addressListVar) {
        ret += adr.serialize(buffer);
      }
    }
    let i = 1;
    for (const value of this.valueList) {
      // Item Number + Value
      ret += S7p.encodeUInt32Vlq(buffer, i);
      ret += value.serialize(buffer);
      i++;
    }
    // 1 Fill byte
    ret += S7p.encodeByte(buffer, 0x00);
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
    s += "<SetMultiVariablesRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<RequestSet>" + "\n";
    s += "<InObjectId>" + this.inObjectId.toString() + "</InObjectId>" + "\n";
    s += "<ItemCount>" + this.valueList.length.toString() + "</ItemCount>" + "\n";
    if (this.inObjectId > 0) {
      s += "<ItemAddressCount>" + this.addressList.length.toString() + "</ItemAddressCount>" + "\n";
      s += "<AddressList>" + "\n";
      for (const id of this.addressList) {
        s += "<Id>" + id.toString() + "</Id>" + "\n";
      }
      s += "</AddressList>" + "\n";
    } else {
      let fieldCount = 0;
      for (const adr of this.addressListVar) {
        fieldCount += adr.getNumberOfFields();
      }
      s += "<NumberOfFields>" + fieldCount.toString() + "</NumberOfFields>" + "\n";
      s += "<AddressList>" + "\n";
      for (const adr of this.addressListVar) {
        s += adr.toString();
      }
      s += "</AddressList>" + "\n";
    }
    s += "<ValueList>" + "\n";
    for (const val of this.valueList) {
      s += "<Value>" + val.toString() + "</Value>" + "\n";
    }
    s += "</ValueList>" + "\n";
    s += "</RequestSet>" + "\n";
    s += "</SetMultiVariablesRequest>" + "\n";
    return s;
  }
}
