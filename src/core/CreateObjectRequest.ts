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
import { PValue, ValueUDInt, ValueRID } from "./PValue.js";
import { Ids } from "./Ids.js";

export class CreateObjectRequest {
  transportFlags = 0x36;
  requestId = 0;
  requestValue!: PValue;
  requestObject!: PObject;
  sessionId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.CreateObject;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = true;

  constructor(protocolVersion: number, seqNum: number, withIntegrityId: boolean) {
    this.protocolVersion = protocolVersion;
    this.sequenceNumber = seqNum;
    this.withIntegrityId = withIntegrityId;
  }

  setRequestIdValue(requestId: number, requestValue: PValue): void {
    this.requestId = requestId;
    this.requestValue = requestValue;
  }

  setRequestObject(requestObject: PObject): void {
    this.requestObject = requestObject;
  }

  setNullServerSessionData(): void {
    // Initializes the data for a Nullserver Session on connection setup.
    // SessionId is set automatically to Ids.ObjectNullServerSession when this object is sent, if there's no session Id.
    this.transportFlags = 0x36;
    this.requestId = Ids.ObjectServerSessionContainer;
    this.requestValue = new ValueUDInt(0);
    this.requestObject = new PObject(Ids.GetNewRIDOnServer, Ids.ClassServerSession, Ids.None);
    this.requestObject.addAttribute(Ids.ServerSessionClientRID, new ValueRID(0x80c3c901));
    this.requestObject.addObject(new PObject(Ids.GetNewRIDOnServer, Ids.ClassSubscriptions, Ids.None));
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
    ret += S7p.encodeUInt32(buffer, this.requestId);
    ret += this.requestValue.serialize(buffer);
    ret += S7p.encodeUInt32(buffer, 0); // Unknown value 1
    if (this.withIntegrityId) {
      ret += S7p.encodeUInt32Vlq(buffer, this.integrityId);
    }
    // Object
    ret += this.requestObject.serialize(buffer);
    // Fill?
    ret += S7p.encodeUInt32(buffer, 0);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<CreateObjectRequest>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<SessionId>" + this.sessionId.toString() + "</SessionId>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<RequestSet>" + "\n";
    s += "<RequestId>" + this.requestId.toString() + "</RequestId>" + "\n";
    s += "<RequestValue>" + this.requestValue.toString() + "</RequestValue>" + "\n";
    s += "<RequestObject>" + this.requestObject.toString() + "</RequestObject>" + "\n";
    s += "</RequestSet>" + "\n";
    s += "</CreateObjectRequest>" + "\n";
    return s;
  }
}
