/*
 * Request parsers and response builders of the mock PLC.
 *
 * The request layouts mirror the C# `Serialize` methods (Core/*Request.cs), the response layouts mirror the C#
 * `Deserialize` methods (Core/*Response.cs, Notification.cs). The value level (PValue, PObject, VLQ ...) is done with
 * the port's own classes, which are validated against the C# driver by test/golden.json.gz.
 */
import {
  ByteStream, S7p, PValue, PObject, Ids, Functioncode, Opcode, ElementID,
  ValueUDIntArray, ValueUDInt,
  ItemAddress,
} from "../../src/index.js";

export interface RequestHeader {
  version: number;
  functionCode: number;
  sequenceNumber: number;
  sessionId: number;
  transportFlags: number;
}

export interface ParsedItemAddress {
  symbolCrc: number;
  accessArea: number;
  accessSubArea: number;
  lid: number[];
}

export type ParsedRequest = RequestHeader & { integrityId: number | null } & (
  | { kind: "InitSsl" }
  | { kind: "CreateObject"; requestId: number; requestValue: PValue | null; object: PObject }
  | { kind: "SetMultiVariables"; inObjectId: number; addressIds: number[]; addresses: ParsedItemAddress[]; values: Array<{ item: number; value: PValue | null }> }
  | { kind: "GetMultiVariables"; linkId: number; addresses: ParsedItemAddress[] }
  | { kind: "SetVariable"; inObjectId: number; address: number; value: PValue | null }
  | { kind: "GetVarSubstreamed"; inObjectId: number; address: number }
  | { kind: "DeleteObject"; objectId: number }
  | { kind: "Explore"; exploreId: number; exploreRequestId: number; recursive: number; parents: number; filter: PValue | null; attributes: number[] }
  | { kind: "Unknown" }
);

/** Parses the object qualifier (S7p.encodeObjectQualifier). */
function skipObjectQualifier(b: ByteStream): void {
  S7p.decodeUInt32(b); // Ids.ObjectQualifier
  for (let i = 0; i < 3; i++) {
    S7p.decodeUInt32Vlq(b); // ParentRID / CompositionAID / KeyQualifier
    PValue.deserialize(b);
  }
  S7p.decodeByte(b); // terminator
}

function parseItemAddress(b: ByteStream): ParsedItemAddress {
  const symbolCrc = S7p.decodeUInt32Vlq(b);
  const accessArea = S7p.decodeUInt32Vlq(b);
  const n = S7p.decodeUInt32Vlq(b);
  const accessSubArea = S7p.decodeUInt32Vlq(b);
  const lid: number[] = [];
  for (let i = 1; i < n; i++) lid.push(S7p.decodeUInt32Vlq(b));
  return { symbolCrc, accessArea, accessSubArea, lid };
}

/**
 * @param data the S7+ PDU data without header/trailer (starts with the opcode)
 * @param expectIntegrityForCreate whether a CreateObject request carries an IntegrityId (false for the very first one)
 */
export function parseRequest(version: number, data: Uint8Array, expectIntegrityForCreate: boolean): ParsedRequest {
  const b = new ByteStream(data);
  const opcode = S7p.decodeByte(b);
  if (opcode !== Opcode.Request) throw new Error("mock PLC: opcode " + opcode + " is not a request");
  S7p.decodeUInt16(b);
  const functionCode = S7p.decodeUInt16(b);
  S7p.decodeUInt16(b);
  const sequenceNumber = S7p.decodeUInt16(b);
  const sessionId = S7p.decodeUInt32(b);
  const transportFlags = S7p.decodeByte(b);
  const hdr: RequestHeader = { version, functionCode, sequenceNumber, sessionId, transportFlags };
  const integrity = (): number => S7p.decodeUInt32Vlq(b);

  switch (functionCode) {
    case Functioncode.InitSsl:
      return { ...hdr, kind: "InitSsl", integrityId: null };

    case Functioncode.CreateObject: {
      const requestId = S7p.decodeUInt32(b);
      const requestValue = PValue.deserialize(b);
      S7p.decodeUInt32(b); // unknown
      const integrityId = expectIntegrityForCreate ? integrity() : null;
      const object = S7p.decodeObject(b, null) as PObject;
      return { ...hdr, kind: "CreateObject", requestId, requestValue, object, integrityId };
    }

    case Functioncode.SetMultiVariables: {
      const inObjectId = S7p.decodeUInt32(b);
      const valueCount = S7p.decodeUInt32Vlq(b);
      const fieldCount = S7p.decodeUInt32Vlq(b);
      const addressIds: number[] = [];
      const addresses: ParsedItemAddress[] = [];
      if (inObjectId > 0) {
        for (let i = 0; i < fieldCount; i++) addressIds.push(S7p.decodeUInt32Vlq(b));
      } else {
        for (let i = 0; i < valueCount; i++) addresses.push(parseItemAddress(b));
      }
      const values: Array<{ item: number; value: PValue | null }> = [];
      for (let i = 0; i < valueCount; i++) {
        const item = S7p.decodeUInt32Vlq(b);
        values.push({ item, value: PValue.deserialize(b) });
      }
      S7p.decodeByte(b); // fill byte
      skipObjectQualifier(b);
      // The session setup request (InObjectId > 0) is sent without IntegrityId
      const integrityId = inObjectId > 0 ? null : integrity();
      return { ...hdr, kind: "SetMultiVariables", inObjectId, addressIds, addresses, values, integrityId };
    }

    case Functioncode.GetMultiVariables: {
      const linkId = S7p.decodeUInt32(b);
      const count = S7p.decodeUInt32Vlq(b);
      S7p.decodeUInt32Vlq(b); // field count
      const addresses: ParsedItemAddress[] = [];
      for (let i = 0; i < count; i++) addresses.push(parseItemAddress(b));
      skipObjectQualifier(b);
      return { ...hdr, kind: "GetMultiVariables", linkId, addresses, integrityId: integrity() };
    }

    case Functioncode.SetVariable: {
      const inObjectId = S7p.decodeUInt32(b);
      S7p.decodeUInt32Vlq(b); // always 1
      const address = S7p.decodeUInt32Vlq(b);
      const value = PValue.deserialize(b);
      skipObjectQualifier(b);
      S7p.decodeByte(b);
      // flags 0x74: "no response needed" request (credit limit); still carries an IntegrityId
      return { ...hdr, kind: "SetVariable", inObjectId, address, value, integrityId: integrity() };
    }

    case Functioncode.GetVarSubStreamed: {
      const inObjectId = S7p.decodeUInt32(b);
      S7p.decodeByte(b); // 0x20 addressarray
      S7p.decodeByte(b); // datatype UDInt
      S7p.decodeByte(b); // size 1
      const address = S7p.decodeUInt32Vlq(b);
      skipObjectQualifier(b);
      S7p.decodeUInt16(b); // 0x0001
      return { ...hdr, kind: "GetVarSubstreamed", inObjectId, address, integrityId: integrity() };
    }

    case Functioncode.DeleteObject: {
      const objectId = S7p.decodeUInt32(b);
      S7p.decodeByte(b);
      skipObjectQualifier(b);
      return { ...hdr, kind: "DeleteObject", objectId, integrityId: integrity() };
    }

    case Functioncode.Explore: {
      const exploreId = S7p.decodeUInt32(b);
      const exploreRequestId = S7p.decodeUInt32Vlq(b);
      const recursive = S7p.decodeByte(b);
      S7p.decodeByte(b); // 1
      const parents = S7p.decodeByte(b);
      let filter: PValue | null = null;
      const marker = S7p.decodeByte(b);
      if (marker === 1) {
        filter = PValue.deserialize(b);
        S7p.decodeByte(b); // number of following objects (0)
      }
      const n = S7p.decodeUInt32Vlq(b);
      const attributes: number[] = [];
      for (let i = 0; i < n; i++) attributes.push(S7p.decodeUInt32Vlq(b));
      return { ...hdr, kind: "Explore", exploreId, exploreRequestId, recursive, parents, filter, attributes, integrityId: integrity() };
    }
  }
  return { ...hdr, kind: "Unknown", integrityId: null };
}

// ----------------------------------------------------------------------------------------------------------
// Response builders. Every builder returns the PDU data (starting with the opcode); the framing layer adds the
// S7+ headers / trailer.
// ----------------------------------------------------------------------------------------------------------

export function responseHeader(b: ByteStream, functionCode: number, sequenceNumber: number, transportFlags = 0x34): void {
  S7p.encodeByte(b, Opcode.Response);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, functionCode);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, sequenceNumber);
  S7p.encodeByte(b, transportFlags);
}

export function buildInitSslResponse(seq: number, returnValue = 0n): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.InitSsl, seq, 0x30);
  S7p.encodeUInt64Vlq(b, returnValue);
  return b.toArray();
}

export function buildCreateObjectResponse(seq: number, returnValue: bigint, objectIds: number[], obj: PObject): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.CreateObject, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  S7p.encodeByte(b, objectIds.length);
  for (const id of objectIds) S7p.encodeUInt32Vlq(b, id);
  obj.serialize(b);
  return b.toArray();
}

export function buildSetMultiVariablesResponse(seq: number, integrity: number, returnValue: bigint, errors: Map<number, bigint>): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.SetMultiVariables, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  for (const [item, err] of errors) {
    S7p.encodeUInt32Vlq(b, item);
    S7p.encodeUInt64Vlq(b, err);
  }
  S7p.encodeUInt32Vlq(b, 0);
  S7p.encodeUInt32Vlq(b, integrity);
  return b.toArray();
}

export function buildGetMultiVariablesResponse(
  seq: number, integrity: number, returnValue: bigint, values: Map<number, PValue>, errors: Map<number, bigint>,
): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.GetMultiVariables, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  for (const [item, v] of values) {
    S7p.encodeUInt32Vlq(b, item);
    v.serialize(b);
  }
  S7p.encodeUInt32Vlq(b, 0);
  for (const [item, err] of errors) {
    S7p.encodeUInt32Vlq(b, item);
    S7p.encodeUInt64Vlq(b, err);
  }
  S7p.encodeUInt32Vlq(b, 0);
  S7p.encodeUInt32Vlq(b, integrity);
  return b.toArray();
}

export function buildSetVariableResponse(seq: number, integrity: number, returnValue: bigint): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.SetVariable, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  S7p.encodeUInt32Vlq(b, integrity);
  return b.toArray();
}

export function buildGetVarSubstreamedResponse(seq: number, integrity: number, returnValue: bigint, value: PValue): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.GetVarSubStreamed, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  S7p.encodeByte(b, 0x01); // unknown
  value.serialize(b);
  S7p.encodeUInt32Vlq(b, integrity);
  return b.toArray();
}

/** The response to deleting the own session object carries no IntegrityId. */
export function buildDeleteObjectResponse(seq: number, integrity: number | null, returnValue: bigint, deletedId: number): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.DeleteObject, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  S7p.encodeUInt32(b, deletedId);
  if (integrity !== null) S7p.encodeUInt32Vlq(b, integrity);
  return b.toArray();
}

export function buildExploreResponse(seq: number, integrity: number, returnValue: bigint, exploreId: number, objects: Uint8Array[]): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, Functioncode.Explore, seq);
  S7p.encodeUInt64Vlq(b, returnValue);
  S7p.encodeUInt32(b, exploreId);
  S7p.encodeUInt32Vlq(b, integrity);
  for (const o of objects) b.write(o);
  return b.toArray();
}

/** A response of another function code (e.g. an error response): the client's DeserializeFromPdu returns null. */
export function buildErrorResponse(seq: number, functionCode: number = Functioncode.Error): Uint8Array {
  const b = new ByteStream();
  responseHeader(b, functionCode, seq);
  S7p.encodeUInt64Vlq(b, 0x8104n);
  return b.toArray();
}

/**
 * Notification (Notification.cs Deserialize):
 * u32 subscription object id, 3x u16, creditTick, seq (VLQ32), then either a non-zero change counter byte or
 * (zero) an 8 byte microsecond UTC timestamp whose first byte is that zero + the change counter, the value items
 * (0x9b, VLQ item reference, PValue ... 0x00), then a 0 byte (no alarm object).
 */
export function buildNotification(opts: {
  subscriptionObjectId: number;
  creditTick: number;
  sequenceNumber: number;
  timestampMicros?: bigint;
  changeCounter?: number;
  values: Map<number, PValue>;
}): Uint8Array {
  const b = new ByteStream();
  S7p.encodeByte(b, Opcode.Notification);
  S7p.encodeUInt32(b, opts.subscriptionObjectId);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, 0);
  S7p.encodeByte(b, opts.creditTick);
  S7p.encodeUInt32Vlq(b, opts.sequenceNumber);
  if (opts.timestampMicros !== undefined) {
    S7p.encodeUInt64(b, opts.timestampMicros); // first byte must be 0
    S7p.encodeByte(b, opts.changeCounter ?? 1);
  } else {
    S7p.encodeByte(b, opts.changeCounter ?? 1);
  }
  for (const [ref, v] of opts.values) {
    S7p.encodeByte(b, 0x9b);
    S7p.encodeUInt32Vlq(b, ref);
    v.serialize(b);
  }
  S7p.encodeByte(b, 0x00); // end of item list
  S7p.encodeByte(b, 0x00); // no alarm object follows
  return b.toArray();
}

/**
 * Alarm notification: like a variable notification without items, followed by the alarm object part
 * (Notification.cs: p2 subscription id u32, u16, return value 0x81, object list).
 */
export function buildAlarmNotification(subscriptionObjectId: number, creditTick: number, seq: number, alarmObj: PObject): Uint8Array {
  const b = new ByteStream();
  S7p.encodeByte(b, Opcode.Notification);
  S7p.encodeUInt32(b, subscriptionObjectId);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, 0);
  S7p.encodeUInt16(b, 0);
  S7p.encodeByte(b, creditTick);
  S7p.encodeUInt32Vlq(b, seq);
  S7p.encodeByte(b, 1); // subscription change counter
  S7p.encodeByte(b, 0x00); // end of (empty) item list
  S7p.encodeUInt32(b, subscriptionObjectId);
  S7p.encodeUInt16(b, 0);
  S7p.encodeByte(b, 0x81);
  alarmObj.serialize(b);
  return b.toArray();
}

// ----------------------------------------------------------------------------------------------------------
// Type information objects (Explore on the type info container). PObject.serialize does not emit the vartype /
// varname lists, so the type info objects are written here following POffsetInfoType / PVartypeList / PVarnameList.
// ----------------------------------------------------------------------------------------------------------

export type OffsetInfo =
  | { t: "std"; opt: number; nonopt: number }
  | { t: "string"; maxLen: number; opt: number; nonopt: number }
  | { t: "array1"; lower: number; count: number; opt: number; nonopt: number; elementLen?: number }
  | { t: "struct"; relationId: number; opt: number; nonopt: number };

export interface TypeInfoVar {
  name: string;
  lid: number;
  softdatatype: number;
  oi: OffsetInfo;
  /** attribute flags without the offsetinfotype nibble (bit offset etc.) */
  attrFlags?: number;
  bitoffsetinfo?: number;
}

const OIT = { Std: 8, String: 9, Array1Dim: 10, Struct: 12 } as const;

function u16le(b: ByteStream, v: number): void { b.writeByte(v & 0xff); b.writeByte((v >> 8) & 0xff); }
function u32le(b: ByteStream, v: number): void { u16le(b, v & 0xffff); u16le(b, (v >>> 16) & 0xffff); }

function writeVartypeElement(b: ByteStream, v: TypeInfoVar): void {
  const oit = v.oi.t === "std" ? OIT.Std : v.oi.t === "string" ? OIT.String : v.oi.t === "array1" ? OIT.Array1Dim : OIT.Struct;
  u32le(b, v.lid);
  u32le(b, 0); // symbol crc
  b.writeByte(v.softdatatype);
  S7p.encodeUInt16(b, ((oit << 12) | (v.attrFlags ?? 0)) & 0xffff);
  b.writeByte(v.bitoffsetinfo ?? 0);
  const oi = v.oi;
  switch (oi.t) {
    case "std":
      u16le(b, oi.opt); u16le(b, oi.nonopt);
      break;
    case "string":
      u16le(b, oi.maxLen); u16le(b, oi.maxLen + 2); u32le(b, oi.opt); u32le(b, oi.nonopt);
      break;
    case "array1":
      u16le(b, oi.elementLen ?? 0); u16le(b, 0); u32le(b, oi.opt); u32le(b, oi.nonopt);
      u32le(b, oi.lower >>> 0); u32le(b, oi.count);
      break;
    case "struct":
      u16le(b, 0); u16le(b, 0); u32le(b, oi.opt); u32le(b, oi.nonopt);
      u32le(b, oi.relationId); u32le(b, 0); u32le(b, 0); u32le(b, 0); u32le(b, 0);
      break;
  }
}

/** Serialises a type info object (relation id = ti rid) with optional attributes and variable lists. */
export function serializeTypeInfoObject(relationId: number, classId: number, vars: TypeInfoVar[], attrs: Array<[number, PValue]> = []): Uint8Array {
  const b = new ByteStream();
  b.writeByte(ElementID.StartOfObject);
  S7p.encodeUInt32(b, relationId);
  S7p.encodeUInt32Vlq(b, classId);
  S7p.encodeUInt32Vlq(b, 0);
  S7p.encodeUInt32Vlq(b, 0);
  for (const [id, v] of attrs) {
    b.writeByte(ElementID.Attribute);
    S7p.encodeUInt32Vlq(b, id);
    v.serialize(b);
  }
  if (vars.length > 0) {
    // PVartypeList: blocklen (u16, counts first id + elements), first id (u32 LE), elements, terminating 0 length
    const blk = new ByteStream();
    u32le(blk, vars[0].lid);
    for (const v of vars) writeVartypeElement(blk, v);
    b.writeByte(ElementID.VartypeList);
    S7p.encodeUInt16(b, blk.length);
    b.write(blk.toArray());
    S7p.encodeUInt16(b, 0);
    // PVarnameList: blocklen (u16), entries: len byte, utf-8 name, 0 byte; terminating 0 length
    const names = new ByteStream();
    for (const v of vars) {
      const nb = new TextEncoder().encode(v.name);
      names.writeByte(nb.length);
      names.write(nb);
      names.writeByte(0);
    }
    b.writeByte(ElementID.VarnameList);
    S7p.encodeUInt16(b, names.length);
    b.write(names.toArray());
    S7p.encodeUInt16(b, 0);
  }
  b.writeByte(ElementID.TerminatingObject);
  return b.toArray();
}

/** Wraps already serialized child objects into a parent object. */
export function serializeContainer(relationId: number, classId: number, children: Uint8Array[]): Uint8Array {
  const b = new ByteStream();
  b.writeByte(ElementID.StartOfObject);
  S7p.encodeUInt32(b, relationId);
  S7p.encodeUInt32Vlq(b, classId);
  S7p.encodeUInt32Vlq(b, 0);
  S7p.encodeUInt32Vlq(b, 0);
  for (const c of children) b.write(c);
  b.writeByte(ElementID.TerminatingObject);
  return b.toArray();
}

/**
 * ValueBlobArray as the PLC sends it in alarm notifications (AssociatedValues): every blob with BlobRootId > 1 uses the
 * special format "8 zero bytes + blob type 0x02" (ValueBlob.DeserializeBody). The port's ValueBlob.serialize does not
 * write this format (the driver only ever reads such values), so the mock writes it itself.
 */
export class AlarmBlobArray extends PValue {
  constructor(private readonly items: Array<{ rootId: number; bytes: Uint8Array }>) {
    super();
  }

  override serialize(b: ByteStream): number {
    const start = b.position;
    S7p.encodeByte(b, PValue.FLAGS_ARRAY);
    S7p.encodeByte(b, 0x14); // Datatype.Blob
    S7p.encodeUInt32Vlq(b, this.items.length);
    for (const it of this.items) {
      S7p.encodeUInt32Vlq(b, it.rootId);
      if (it.rootId > 1) {
        S7p.encodeUInt64(b, 0n);
        S7p.encodeByte(b, 0x02);
      }
      S7p.encodeUInt32Vlq(b, it.bytes.length);
      b.write(it.bytes);
    }
    return b.position - start;
  }

  override toString(): string {
    return "<AlarmBlobArray/>";
  }
}

export function itemKey(a: ParsedItemAddress | ItemAddress): string {
  return (a.accessArea >>> 0).toString(16).toUpperCase() + a.lid.map((l) => "." + (l >>> 0).toString(16).toUpperCase()).join("");
}

export { ValueUDIntArray, ValueUDInt };
