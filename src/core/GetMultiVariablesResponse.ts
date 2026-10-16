/**
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import { dictAdd } from "./NetCompat.js";
import { ByteStream } from "./ByteStream.js";
import { Functioncode } from "./Functioncode.js";
import { Opcode } from "./Opcode.js";
import { S7p } from "./S7p.js";
import { PValue } from "./PValue.js";

export class GetMultiVariablesResponse {
  transportFlags = 0;
  returnValue = 0n;
  values: Map<number, PValue> = new Map(); // ItemNumber, Value
  errorValues: Map<number, bigint> = new Map(); // ItemNumber, ReturnValue
  protocolVersion = 0;
  get functionCode(): number {
    return Functioncode.GetMultiVariables;
  }
  sequenceNumber = 0;
  integrityId = 0;
  withIntegrityId = false;

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
    this.errorValues = new Map();
    this.values = new Map();
    this.withIntegrityId = true;
  }

  /** Returns the number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    let itemnr = 0;
    this.sequenceNumber = S7p.decodeUInt16(buffer);
    this.transportFlags = S7p.decodeByte(buffer);
    // Response Set
    this.returnValue = S7p.decodeUInt64Vlq(buffer);
    this.errorValues.clear();
    // ValueList
    itemnr = S7p.decodeUInt32Vlq(buffer);
    while (itemnr > 0) {
      const v = PValue.deserialize(buffer)!;
      dictAdd(this.values, itemnr, v);
      itemnr = S7p.decodeUInt32Vlq(buffer);
    }
    // ErrorvalueList
    itemnr = S7p.decodeUInt32Vlq(buffer);
    while (itemnr > 0) {
      const retval = S7p.decodeUInt64Vlq(buffer);
      dictAdd(this.errorValues, itemnr, retval);
      itemnr = S7p.decodeUInt32Vlq(buffer);
    }
    this.integrityId = S7p.decodeUInt32Vlq(buffer);
    return buffer.position - start;
  }

  toString(): string {
    let s = "";
    s += "<GetMultiVariablesResponse>" + "\n";
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + "\n";
    s += "<SequenceNumber>" + this.sequenceNumber.toString() + "</SequenceNumber>" + "\n";
    s += "<TransportFlags>" + this.transportFlags.toString() + "</TransportFlags>" + "\n";
    s += "<ResponseSet>" + "\n";
    s += "<ReturnValue>" + this.returnValue.toString() + "</ReturnValue>" + "\n";
    s += "<ValueList>" + "\n";
    for (const [key, value] of this.values) {
      s += "<Value>" + "\n";
      s += "<ItemNr>" + key.toString() + "</ItemNr>" + "\n";
      s += value.toString();
      s += "</Value>" + "\n";
    }
    s += "</ValueList>" + "\n";
    s += "<ErrorValueList>" + "\n";
    for (const [key, value] of this.errorValues) {
      s += "<ErrorValue>" + "\n";
      s += "<ItemNr>" + key.toString() + "</ItemNr>" + "\n";
      s += "<ReturnValue>" + value.toString() + "</ReturnValue>" + "\n";
      s += "</ErrorValue>" + "\n";
    }
    s += "</ErrorValueList>" + "\n";
    s += "</ResponseSet>" + "\n";
    s += "<IntegrityId>" + this.integrityId.toString() + "</IntegrityId>" + "\n";
    s += "</GetMultiVariablesResponse>" + "\n";
    return s;
  }

  static deserializeFromPdu(pdu: ByteStream): GetMultiVariablesResponse | null {
    // Special handling of ProtocolVersion, which is written to the stream before
    const protocolVersion = S7p.decodeByte(pdu);
    const opcode = S7p.decodeByte(pdu);
    if (opcode !== Opcode.Response) {
      return null;
    }
    S7p.decodeUInt16(pdu); // reserved
    const fn = S7p.decodeUInt16(pdu);
    S7p.decodeUInt16(pdu); // reserved
    if (fn !== Functioncode.GetMultiVariables) {
      return null;
    }
    const resp = new GetMultiVariablesResponse(protocolVersion);
    resp.deserialize(pdu);
    return resp;
  }
}
