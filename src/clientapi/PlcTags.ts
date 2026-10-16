/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */
import type { PValue } from "../core/PValue.js";
import { Softdatatype } from "../core/Softdatatype.js";
import type { S7CommPlusConnection } from "../S7CommPlusConnection.js";
import type { ItemAddress } from "./ItemAddress.js";
import {
  PlcTag,
  PlcTagAny,
  PlcTagBool,
  PlcTagBoolArray,
  PlcTagByte,
  PlcTagByteArray,
  PlcTagChar,
  PlcTagDInt,
  PlcTagDIntArray,
  PlcTagDTL,
  PlcTagDWord,
  PlcTagDWordArray,
  PlcTagDate,
  PlcTagDateAndTime,
  PlcTagDateAndTimeArray,
  PlcTagInt,
  PlcTagIntArray,
  PlcTagLDT,
  PlcTagLInt,
  PlcTagLReal,
  PlcTagLTOD,
  PlcTagLTime,
  PlcTagLWord,
  PlcTagPointer,
  PlcTagReal,
  PlcTagRealArray,
  PlcTagS5Time,
  PlcTagSInt,
  PlcTagSIntArray,
  PlcTagString,
  PlcTagStringArray,
  PlcTagTime,
  PlcTagTimeOfDay,
  PlcTagUDInt,
  PlcTagUDIntArray,
  PlcTagULInt,
  PlcTagUInt,
  PlcTagUIntArray,
  PlcTagUSInt,
  PlcTagUSIntArray,
  PlcTagWChar,
  PlcTagWString,
  PlcTagWord,
  PlcTagWordArray,
} from "./PlcTag.js";

/**
 * Members of the connection used by the tag helpers (C# extension methods on S7CommPlusConnection).
 * ReadValues / WriteValues keep the C# `int` error code convention, `out` params are returned in the result object.
 */
export interface PlcTagsConnection {
  readValues(addresses: ItemAddress[]): Promise<{ res: number; values: unknown[]; errors: bigint[] }>;
  writeValues(addresses: ItemAddress[], values: PValue[]): Promise<{ res: number; errors: bigint[] }>;
}

export async function readTags(conn: S7CommPlusConnection | PlcTagsConnection, plcTags: Iterable<PlcTag>): Promise<number> {
  const c = conn as unknown as PlcTagsConnection;
  const tags = Array.from(plcTags);
  const readlist: ItemAddress[] = [];

  for (const tag of tags) {
    readlist.push(tag.address);
  }

  const { res, values, errors } = await c.readValues(readlist);

  if (res === 0) {
    let idx = 0;
    for (const tag of tags) {
      tag.processReadResult(values[idx], errors[idx]);
      idx++;
    }
  } else {
    console.log("ReadTags: Error res=" + res);
  }
  return res;
}

export async function writeTags(conn: S7CommPlusConnection | PlcTagsConnection, plcTags: Iterable<PlcTag>): Promise<number> {
  const c = conn as unknown as PlcTagsConnection;
  const tags = Array.from(plcTags);
  const writelist: ItemAddress[] = [];
  const values: PValue[] = [];

  for (const tag of tags) {
    writelist.push(tag.address);
    values.push(tag.getWriteValue());
  }

  const { res, errors } = await c.writeValues(writelist, values);

  if (res === 0) {
    let idx = 0;
    for (const tag of tags) {
      tag.processWriteResult(errors[idx]);
      idx++;
    }
  } else {
    console.log("WriteTags: Error res=" + res);
  }
  return res;
}

type TagCtor = new (name: string, address: ItemAddress, softdatatype: number) => PlcTag;

/** softdatatype -> [scalar tag class, optional 1-dim array tag class used when Is1Dim is set] */
const tagTable = new Map<number, [TagCtor, TagCtor?]>([
  [Softdatatype.S7COMMP_SOFTDATATYPE_BOOL, [PlcTagBool, PlcTagBoolArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_BYTE, [PlcTagByte, PlcTagByteArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_CHAR, [PlcTagChar]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_WORD, [PlcTagWord, PlcTagWordArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_INT, [PlcTagInt, PlcTagIntArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DWORD, [PlcTagDWord, PlcTagDWordArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DINT, [PlcTagDInt, PlcTagDIntArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_REAL, [PlcTagReal, PlcTagRealArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DATE, [PlcTagDate]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_TIMEOFDAY, [PlcTagTimeOfDay]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_TIME, [PlcTagTime]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_S5TIME, [PlcTagS5Time]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DATEANDTIME, [PlcTagDateAndTime, PlcTagDateAndTimeArray]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_STRING, [PlcTagString, PlcTagStringArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_POINTER, [PlcTagPointer]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_ANY, [PlcTagAny]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFB, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFC, [PlcTagUInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_COUNTER, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_TIMER, [PlcTagUInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL, [PlcTagBool, PlcTagBoolArray]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_LREAL, [PlcTagLReal]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_ULINT, [PlcTagULInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_LINT, [PlcTagLInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_LWORD, [PlcTagLWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_USINT, [PlcTagUSInt, PlcTagUSIntArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_UINT, [PlcTagUInt, PlcTagUIntArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_UDINT, [PlcTagUDInt, PlcTagUDIntArray]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_SINT, [PlcTagSInt, PlcTagSIntArray]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_WCHAR, [PlcTagWChar]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_WSTRING, [PlcTagWString]],
  // Softdatatype.S7COMMP_SOFTDATATYPE_VARIANT:
  // -> Variant isn't added inside of the instance-db as a variable!
  [Softdatatype.S7COMMP_SOFTDATATYPE_LTIME, [PlcTagLTime]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_LTOD, [PlcTagLTOD]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_LDT, [PlcTagLDT]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DTL, [PlcTagDTL]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_REMOTE, [PlcTagAny]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_AOMIDENT, [PlcTagDWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_EVENTANY, [PlcTagDWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_EVENTATT, [PlcTagDWord]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_AOMAID, [PlcTagDWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_AOMLINK, [PlcTagDWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_EVENTHWINT, [PlcTagDWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWANY, [PlcTagWord]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_HWIOSYSTEM, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWDPMASTER, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWDEVICE, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWDPSLAVE, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWIO, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWMODULE, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWSUBMODULE, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWHSC, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWPWM, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWPTO, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWINTERFACE, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_HWIEPORT, [PlcTagWord]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_OBANY, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBDELAY, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBTOD, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBCYCLIC, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBATT, [PlcTagInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_CONNANY, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_CONNPRG, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_CONNOUC, [PlcTagWord]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_CONNRID, [PlcTagDWord]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_PORT, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_RTM, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_PIP, [PlcTagUInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_OBPCYCLE, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBHWINT, [PlcTagInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_OBDIAG, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBTIMEERROR, [PlcTagInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_OBSTARTUP, [PlcTagInt]],

  [Softdatatype.S7COMMP_SOFTDATATYPE_DBANY, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DBWWW, [PlcTagUInt]],
  [Softdatatype.S7COMMP_SOFTDATATYPE_DBDYN, [PlcTagUInt]],
]);

export function tagFactory(name: string, address: ItemAddress, softdatatype: number, is1Dim = false): PlcTag | null {
  const entry = tagTable.get(softdatatype);
  if (entry === undefined) {
    console.log("ERROR: Unknown softdatatype=" + softdatatype.toString() + " for variable= " + name);
    return null;
  }
  const [scalar, array] = entry;
  const Ctor = is1Dim && array !== undefined ? array : scalar;
  return new Ctor(name, address, softdatatype);
}

/** Static-class style access, mirroring the C# `PlcTags` class. */
export const PlcTags = { readTags, writeTags, tagFactory };
