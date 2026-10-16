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

export class DeleteObjectResponse {
  transportFlags = 0;
  returnValue = 0n;
  deleteObjectId = 0;
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.DeleteObject;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = false;

  constructor(protocolVersion: number, withIntegrityId: boolean) {
    this.protocolVersion = protocolVersion;
    this.withIntegrityId = withIntegrityId; // When deleting the Sesssion Object-Id, there's no Integrity-Id!
  }

  /** Returns the number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    this.sequenceNumber = S7p.decodeUInt16(buffer);
    this.transportFlags = S7p.decodeByte(buffer);
    // Response Set
    this.returnValue = S7p.decodeUInt64Vlq(buffer);
    this.deleteObjectId = S7p.decodeUInt32(buffer);
    if ((this.returnValue & 0x4000000000000000n) > 0n) {
      // Error Extension
      // Decode the error object, but don't use any informations from it. Must be processed on a higher level.
      S7p.decodeObject(buffer, new PObject());
    }
    if (this.withIntegrityId) {
      this.integrityId = S7p.decodeUInt32Vlq(buffer);
    }
    return buffer.position - start;
  }

  toString(): string {
    let s = "";
    s += "<DeleteObjectResponse>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<ResponseSet>" + "\n";
    s += "<ReturnValue>" + this.returnValue.toString() + "</ReturnValue>" + "\n";
    s += "<DeleteObjectId>" + this.deleteObjectId.toString() + "</DeleteObjectId>" + "\n";
    s += "</ResponseSet>" + "\n";
    s += "<WithIntegrityId>" + (this.withIntegrityId ? "True" : "False") + "</WithIntegrityId>" + "\n";
    s += "<IntegrityId>" + this.integrityId.toString() + "</IntegrityId>" + "\n";
    s += "</DeleteObjectResponse>" + "\n";
    return s;
  }

  static deserializeFromPdu(pdu: ByteStream, withIntegrityId: boolean): DeleteObjectResponse | null {
    // Special handling of ProtocolVersion, which is written to the stream before
    const protocolVersion = S7p.decodeByte(pdu);
    const opcode = S7p.decodeByte(pdu);
    if (opcode !== Opcode.Response) {
      return null;
    }
    S7p.decodeUInt16(pdu); // reserved
    const fn = S7p.decodeUInt16(pdu);
    S7p.decodeUInt16(pdu); // reserved
    if (fn !== Functioncode.DeleteObject) {
      return null;
    }
    const resp = new DeleteObjectResponse(protocolVersion, withIntegrityId);
    resp.deserialize(pdu);
    return resp;
  }
}
