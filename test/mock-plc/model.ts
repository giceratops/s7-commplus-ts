/*
 * The fake PLC program browsed / read / written by the integration tests: a few datablocks with a type info
 * description and initial values.
 */
import {
  Softdatatype, PValue, ItemAddress, PlcTagString,
  ValueBool, ValueInt, ValueDInt, ValueReal, ValueLReal, ValueByte, ValueWord, ValueDWord, ValueLInt, ValueUSInt,
  ValueUSIntArray, ValueIntArray, ValueUDInt, ValueByteArray,
} from "../../src/index.js";
import type { TypeInfoVar } from "./messages.js";

export interface DbDef {
  name: string;
  number: number;
  /** relation id of the datablock (0x8A0E0000 + number) */
  relId: number;
  /** relation id of the type info; 0 = reading LID 1 fails (DB only present in load memory) */
  tiRelId: number;
  vars: TypeInfoVar[];
}

export interface StructDef {
  tiRelId: number;
  vars: TypeInfoVar[];
  /** TI_TComSize */
  size: number;
}

const S = Softdatatype;

export const DB1_REL = 0x8a0e0001;
export const DB1_TI = 0x00b00001;
export const STRUCT_TI = 0x00b00002;
export const DB2_REL = 0x8a0e0002;
export const DB2_TI = 0x00b00003;
export const DB3_REL = 0x8a0e0003; // no type info available
export const STRUCT_ARRAY_TI = 0x00b00004;

const std = (opt: number, nonopt = opt): TypeInfoVar["oi"] => ({ t: "std", opt, nonopt });

export function defaultStructs(): StructDef[] {
  return [
    {
      tiRelId: STRUCT_TI,
      size: 16,
      vars: [
        { name: "speed", lid: 1, softdatatype: S.S7COMMP_SOFTDATATYPE_LREAL, oi: std(0, 0) },
        { name: "running", lid: 2, softdatatype: S.S7COMMP_SOFTDATATYPE_BOOL, oi: std(8, 8), attrFlags: 0 },
        { name: "mode", lid: 3, softdatatype: S.S7COMMP_SOFTDATATYPE_BYTE, oi: std(9, 9) },
      ],
    },
  ];
}

export function defaultDbs(): DbDef[] {
  return [
    {
      name: "TestDB",
      number: 1,
      relId: DB1_REL,
      tiRelId: DB1_TI,
      vars: [
        { name: "flag", lid: 0x0a, softdatatype: S.S7COMMP_SOFTDATATYPE_BOOL, oi: std(0, 0) },
        { name: "counter", lid: 0x0b, softdatatype: S.S7COMMP_SOFTDATATYPE_INT, oi: std(2, 2) },
        { name: "bigNumber", lid: 0x0c, softdatatype: S.S7COMMP_SOFTDATATYPE_DINT, oi: std(4, 4) },
        { name: "temperature", lid: 0x0d, softdatatype: S.S7COMMP_SOFTDATATYPE_REAL, oi: std(8, 8) },
        { name: "name", lid: 0x0e, softdatatype: S.S7COMMP_SOFTDATATYPE_STRING, oi: { t: "string", maxLen: 254, opt: 12, nonopt: 12 } },
        {
          name: "samples", lid: 0x0f, softdatatype: S.S7COMMP_SOFTDATATYPE_INT,
          oi: { t: "array1", lower: 0, count: 4, opt: 270, nonopt: 270, elementLen: 2 },
        },
        {
          name: "motor", lid: 0x10, softdatatype: S.S7COMMP_SOFTDATATYPE_STRUCT,
          oi: { t: "struct", relationId: STRUCT_TI, opt: 280, nonopt: 280 },
        },
        { name: "word", lid: 0x11, softdatatype: S.S7COMMP_SOFTDATATYPE_WORD, oi: std(300, 300) },
        { name: "dword", lid: 0x12, softdatatype: S.S7COMMP_SOFTDATATYPE_DWORD, oi: std(302, 302) },
        { name: "lreal", lid: 0x13, softdatatype: S.S7COMMP_SOFTDATATYPE_LREAL, oi: std(306, 306) },
        { name: "lint", lid: 0x14, softdatatype: S.S7COMMP_SOFTDATATYPE_LINT, oi: std(314, 314) },
        { name: "usint", lid: 0x15, softdatatype: S.S7COMMP_SOFTDATATYPE_USINT, oi: std(322, 322) },
        { name: "udint", lid: 0x16, softdatatype: S.S7COMMP_SOFTDATATYPE_UDINT, oi: std(324, 324) },
        {
          name: "shortText", lid: 0x17, softdatatype: S.S7COMMP_SOFTDATATYPE_STRING,
          oi: { t: "string", maxLen: 20, opt: 328, nonopt: 328 },
        },
        {
          name: "bytes", lid: 0x18, softdatatype: S.S7COMMP_SOFTDATATYPE_BYTE,
          oi: { t: "array1", lower: 0, count: 2000, opt: 350, nonopt: 350, elementLen: 1 },
        },
      ],
    },
    {
      name: "Other",
      number: 2,
      relId: DB2_REL,
      tiRelId: DB2_TI,
      vars: [{ name: "value", lid: 0x0a, softdatatype: S.S7COMMP_SOFTDATATYPE_DINT, oi: std(0, 0) }],
    },
    { name: "LoadMemoryOnly", number: 3, relId: DB3_REL, tiRelId: 0, vars: [] },
  ];
}

export const hexU = (n: number): string => (n >>> 0).toString(16).toUpperCase();

/** Initial values keyed by access sequence (e.g. "8A0E0001.B"). */
export function defaultValues(): Map<string, PValue> {
  const m = new Map<string, PValue>();
  const k = (rel: number, ...lids: number[]): string => [hexU(rel), ...lids.map(hexU)].join(".");
  m.set(k(DB1_REL, 0x0a), new ValueBool(true));
  m.set(k(DB1_REL, 0x0b), new ValueInt(-1234));
  m.set(k(DB1_REL, 0x0c), new ValueDInt(123456789));
  m.set(k(DB1_REL, 0x0d), new ValueReal(21.5));
  m.set(k(DB1_REL, 0x0e), stringValue("hello plc", 254));
  for (let i = 0; i < 4; i++) m.set(k(DB1_REL, 0x0f, i), new ValueInt(100 + i));
  m.set(k(DB1_REL, 0x10, 1), new ValueLReal(1500.25));
  m.set(k(DB1_REL, 0x10, 2), new ValueBool(false));
  m.set(k(DB1_REL, 0x10, 3), new ValueByte(7));
  m.set(k(DB1_REL, 0x11), new ValueWord(0xbeef));
  m.set(k(DB1_REL, 0x12), new ValueDWord(0xdeadbeef));
  m.set(k(DB1_REL, 0x13), new ValueLReal(-0.5));
  m.set(k(DB1_REL, 0x14), new ValueLInt(-9007199254740993n));
  m.set(k(DB1_REL, 0x15), new ValueUSInt(200));
  m.set(k(DB1_REL, 0x16), new ValueUDInt(4000000000));
  m.set(k(DB1_REL, 0x17), stringValue("short", 20));
  m.set(k(DB1_REL, 0x0f), new ValueIntArray([100, 101, 102, 103]));
  m.set(k(DB1_REL, 0x18), new ValueByteArray(Uint8Array.from({ length: 2000 }, (_, i) => (i * 7 + 3) & 0xff)));
  m.set(k(DB2_REL, 0x0a), new ValueDInt(42));
  return m;
}

/** A String[maxLen] as transmitted by the PLC: USInt array [maxLen, actLen, chars..., padding]. */
export function stringValue(text: string, maxLen: number): ValueUSIntArray {
  const t = new PlcTagString("x", new ItemAddress("8A0E0001.A"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, maxLen);
  t.value = text;
  return t.getWriteValue() as ValueUSIntArray;
}

export { ValueIntArray };
