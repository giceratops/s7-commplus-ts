/*
 * Alarm data of the mock PLC and the byte layouts of the alarm related Explore answers. The layouts are derived from the
 * C# parsing code (Alarming/BrowseAlarms.cs: ExploreASAlarms / GetTexts / GetActiveAlarms, AlarmsMultipleStai,
 * AlarmsHmiInfo, AlarmsAlarmTexts, AlarmsAsCgs, AlarmsAssociatedValues):
 *
 *  - ExploreId 0x8A7E0000 (ASAlarms.0, recursive): object 0x8A7E0000 with a child MultipleSTAI object whose attribute
 *    MultipleSTAI_STAIs is a BlobSparseArray; every blob is one AlarmsMultipleStai (big endian).
 *  - ExploreId thePLCProgram with the attributes (ParentObject, MultipleSTAI_STAIs): PLCProgram object whose children
 *    (one per program block with alarms) each carry a MultipleSTAI child like above. The relation id of the child is
 *    the first half of the CPU alarm id.
 *  - ExploreId 0x8A360000 + language id: TextLibrary object with TextLibraryOffsetArea (3 blobs, little endian tables)
 *    and TextLibraryStringArea.
 *  - ExploreId theAlarmSubsystem / itsUpdateRelevantDAI: one DAI object per active alarm with the same attributes as an
 *    alarm notification.
 */
import {
  ByteStream, Ids, PObject, ValueBlob, ValueBlobSparseArray, ValueDInt, ValueLWord, ValueStruct, ValueTimestamp, ValueUDInt,
  ValueUInt, ValueUSInt, ValueWString,
} from "../../src/index.js";
import type { PValue } from "../../src/index.js";
import { AlarmBlobArray } from "./messages.js";

export const AS_ALARMS_REL = 0x8a7e0000;
export const TEXT_LIBRARY_BASE = 0x8a360000;
export const LANG_DE = 1031;
export const LANG_EN = 1033;
export const LANG_FR = 1036;

export interface HmiInfoDef {
  syntaxId: number;
  version: number;
  clientAlarmId: number;
  priority: number;
  /** syntaxId >= 257 */
  reserved?: [number, number, number];
  /** syntaxId >= 258 */
  alarmClass?: number;
  producer?: number;
  groupId?: number;
  flags?: number;
}

export interface AlarmTextSet {
  info?: string;
  alarm?: string;
  /** AdditionalText1..9 */
  additional?: string[];
  /** the two "unknown" values (type index 255) */
  unknown?: [number, number];
}

export interface StaiDef {
  /** relation id of the parent (0x8A7E0000 for the AS alarms, otherwise the program block) */
  relationId: number;
  alid: number;
  alarmDomain: number;
  messageType: number;
  alarmEnabled: number;
  hmi: HmiInfoDef;
  lids: number[];
  /** texts per language id */
  texts: Record<number, AlarmTextSet>;
}

export interface CgsDef {
  allStatesInfo: number;
  /** nanoseconds since 1970 */
  timestamp: bigint;
  ackTimestamp: bigint;
  associated: Array<{ rootId: number; bytes: Uint8Array }>;
}

export interface ActiveAlarmDef {
  /** relation id of the DAI object */
  objectId: number;
  name: string;
  cpuAlarmId: bigint;
  allStatesInfo: number;
  alarmDomain: number;
  messageType: number;
  hmi: HmiInfoDef;
  sequenceCounter: number;
  coming?: CgsDef;
  going?: CgsDef;
  /** texts per language id */
  texts: Record<number, AlarmTextSet>;
}

export interface AlarmModel {
  stais: StaiDef[];
  /** relation ids of program blocks that exist in the alarm explore but have no MultipleSTAI child */
  blocksWithoutAlarms: number[];
  /** text library entries for alarms that are not in the STAI list (the client must skip them) */
  orphanTexts: Array<{ relationId: number; alid: number; texts: Record<number, AlarmTextSet> }>;
  /** the MultipleSTAI_STAIs attribute of the program blocks is a plain Blob instead of a BlobSparseArray */
  userStaisAsPlainBlob: boolean;
  active: ActiveAlarmDef[];
  /** attributes the active alarm objects do not contain (to provoke client errors) */
  omitActiveAttributes: number[];
  /** a DAI object without DAI.Coming / DAI.Going is added to the active alarms */
  oddActive: boolean;
}

export const cpuAlarmId = (relationId: number, alid: number): bigint => (BigInt(relationId) << 32n) | (BigInt(alid) << 16n);

const DB1 = 0x8a0e0001;
const MAIN_FC = 0x00010001;
const EMPTY_FB = 0x00010002;
const GONE = 0x8a0e0009;

const be16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const utf8 = (s: string): number[] => [...Buffer.from(s, "utf8")];

export function defaultAlarmModel(): AlarmModel {
  const stais: StaiDef[] = [
    {
      relationId: AS_ALARMS_REL, alid: 1, alarmDomain: 1, messageType: 1, alarmEnabled: 1,
      hmi: { syntaxId: 258, version: 1, clientAlarmId: 1001, priority: 5, reserved: [0, 0, 0], alarmClass: 1, producer: 2, groupId: 0, flags: 0 },
      lids: [],
      texts: {
        [LANG_DE]: { info: "Systemdiagnose", alarm: "Baugruppe fehlt oder defekt", additional: ["Steckplatz", "Rack"], unknown: [3, 0] },
        [LANG_EN]: { info: "System diagnostics", alarm: "Module missing or defective", additional: ["Slot", "Rack"], unknown: [3, 0] },
      },
    },
    {
      relationId: AS_ALARMS_REL, alid: 2, alarmDomain: 2, messageType: 3, alarmEnabled: 0,
      hmi: { syntaxId: 257, version: 1, clientAlarmId: 1002, priority: 9, reserved: [1, 2, 3] },
      lids: [0x00000011],
      texts: { [LANG_DE]: { alarm: "Zugriffsschutz: falsches Passwort" }, [LANG_EN]: { alarm: "Access protection: wrong password" } },
    },
    {
      relationId: DB1, alid: 1, alarmDomain: 256, messageType: 1, alarmEnabled: 1,
      hmi: { syntaxId: 258, version: 2, clientAlarmId: 2001, priority: 12, reserved: [0, 0, 0], alarmClass: 3, producer: 4, groupId: 5, flags: 6 },
      lids: [0x00010001, 0x00010002, 0x00010003],
      texts: {
        [LANG_DE]: {
          info: "Hilfetext zur Motorstörung", alarm: "Motor überlastet", unknown: [1, 2],
          additional: ["Zusatz 1", "Zusatz 2", "Zusatz 3", "Zusatz 4", "Zusatz 5", "Zusatz 6", "Zusatz 7", "Zusatz 8", "Zusatz 9"],
        },
        [LANG_EN]: {
          info: "Help text for the motor fault", alarm: "Motor overload", unknown: [1, 2],
          additional: ["Add 1", "Add 2", "Add 3", "Add 4", "Add 5", "Add 6", "Add 7", "Add 8", "Add 9"],
        },
        [LANG_FR]: { alarm: "Moteur en surcharge" },
      },
    },
    {
      relationId: DB1, alid: 2, alarmDomain: 257, messageType: 2, alarmEnabled: 1,
      hmi: { syntaxId: 256, version: 2, clientAlarmId: 2002, priority: 1 },
      lids: [],
      texts: { [LANG_DE]: { alarm: "Füllstand niedrig", additional: ["Tank 1"] }, [LANG_EN]: { alarm: "Level low", additional: ["Tank 1"] } },
    },
    {
      relationId: MAIN_FC, alid: 7, alarmDomain: 258, messageType: 4, alarmEnabled: 1,
      hmi: { syntaxId: 258, version: 1, clientAlarmId: 3007, priority: 3, reserved: [0, 0, 0], alarmClass: 2, producer: 1, groupId: 1, flags: 1 },
      lids: [0x00020001],
      texts: { [LANG_DE]: { info: "Zylinder prüfen", alarm: "Zylinder klemmt" } },
    },
    {
      relationId: MAIN_FC, alid: 8, alarmDomain: 258, messageType: 1, alarmEnabled: 0,
      hmi: { syntaxId: 258, version: 1, clientAlarmId: 3008, priority: 3, reserved: [0, 0, 0], alarmClass: 2, producer: 1, groupId: 1, flags: 1 },
      lids: [],
      texts: {},
    },
  ];
  const ts = 1_700_000_000_000_000_000n;
  const assoc = (rootId: number, bytes: number[]): { rootId: number; bytes: Uint8Array } => ({ rootId, bytes: Uint8Array.from(bytes) });
  const typeInfo = assoc(Ids.AS_CGS_AssociatedValues, [0, 1, 0, 0]);
  const active: ActiveAlarmDef[] = [
    {
      objectId: 0x1001, name: "DAI_Motor", cpuAlarmId: cpuAlarmId(DB1, 1), allStatesInfo: 0x05, alarmDomain: 256, messageType: 1,
      hmi: { syntaxId: 258, version: 2, clientAlarmId: 2001, priority: 12, reserved: [0, 0, 0], alarmClass: 3, producer: 4, groupId: 5, flags: 6 },
      sequenceCounter: 41,
      coming: {
        allStatesInfo: 1, timestamp: ts, ackTimestamp: 0n,
        associated: [
          typeInfo,
          assoc(Ids.TI_INT, [0xff, 0xfe]),
          assoc(Ids.TI_DINT, [0x00, 0x00, 0x01, 0x00]),
          assoc(Ids.TI_BOOL, [1]),
          assoc(Ids.TI_STRING_START + 20, [20, 5, ...utf8("hello")]),
          assoc(Ids.TI_REAL, [0x40, 0x60, 0x00, 0x00]), // 3.5
          assoc(Ids.TI_WSTRING_START + 8, [...be16(8), ...be16(3), 0x00, 0x41, 0x00, 0x42, 0x20, 0xac]), // "AB" + euro
          assoc(Ids.TI_UDINT, [0xff, 0xff, 0xff, 0xff]),
          assoc(Ids.TI_SINT, [0xf6]),
          assoc(Ids.TI_WORD, [0x12, 0x34]),
          assoc(Ids.TI_LREAL, [0x3f, 0xf8, 0, 0, 0, 0, 0, 0]), // 1.5
        ],
      },
      texts: {
        [LANG_DE]: { info: "Hilfetext zur Motorstörung", alarm: "Motor überlastet", additional: ["Zusatz 1", "Zusatz 2"] },
        [LANG_EN]: { info: "Help text for the motor fault", alarm: "Motor overload", additional: ["Add 1", "Add 2"] },
      },
    },
    {
      objectId: 0x1002, name: "DAI_Module", cpuAlarmId: cpuAlarmId(AS_ALARMS_REL, 1), allStatesInfo: 0x0a, alarmDomain: 1, messageType: 1,
      hmi: { syntaxId: 257, version: 1, clientAlarmId: 1001, priority: 5, reserved: [0, 0, 0] },
      sequenceCounter: 42,
      going: {
        allStatesInfo: 2, timestamp: ts + 5_000_000_000n, ackTimestamp: ts + 9_000_000_000n,
        associated: [typeInfo, assoc(Ids.TI_BYTE, [0x7f]), assoc(Ids.TI_CHAR, [0x58]), assoc(Ids.TI_WCHAR, [0x00, 0x59]), assoc(Ids.TI_UINT, [0xff, 0xfe]), assoc(Ids.TI_DWORD, [0xde, 0xad, 0xbe, 0xef])],
      },
      texts: { [LANG_EN]: { info: "System diagnostics", alarm: "Module missing or defective" } },
    },
    {
      objectId: 0x1003, name: "DAI_Cylinder", cpuAlarmId: cpuAlarmId(MAIN_FC, 7), allStatesInfo: 0x05, alarmDomain: 258, messageType: 4,
      hmi: { syntaxId: 258, version: 1, clientAlarmId: 3007, priority: 3, reserved: [0, 0, 0], alarmClass: 2, producer: 1, groupId: 1, flags: 1 },
      sequenceCounter: 43,
      coming: { allStatesInfo: 1, timestamp: ts + 60_000_000_000n, ackTimestamp: 0n, associated: [typeInfo] },
      texts: { [LANG_DE]: { info: "Zylinder prüfen", alarm: "Zylinder klemmt" }, [LANG_FR]: { alarm: "Vérin bloqué" } },
    },
  ];
  return {
    stais,
    blocksWithoutAlarms: [EMPTY_FB],
    orphanTexts: [{ relationId: GONE, alid: 4, texts: { [LANG_DE]: { alarm: "Alarm ohne Definition" }, [LANG_EN]: { alarm: "Alarm without definition" } } }],
    userStaisAsPlainBlob: false,
    active,
    omitActiveAttributes: [],
    oddActive: false,
  };
}

// ----------------------------------------------------------------------------------------------------------------
// STAI blobs
// ----------------------------------------------------------------------------------------------------------------

export function hmiInfoBytes(h: HmiInfoDef): number[] {
  const b = [...be16(h.syntaxId), ...be16(h.version), ...be32(h.clientAlarmId), h.priority];
  if (h.syntaxId >= 257) {
    b.push(...(h.reserved ?? [0, 0, 0]));
    if (h.syntaxId >= 258) b.push(...be16(h.alarmClass ?? 0), h.producer ?? 0, h.groupId ?? 0, h.flags ?? 0);
  }
  return b;
}

export function staiBytes(s: StaiDef): Uint8Array {
  const hmi = hmiInfoBytes(s.hmi);
  const b = [...be16(s.alid), ...be16(s.alarmDomain), ...be16(s.messageType), s.alarmEnabled, ...be16(hmi.length), ...hmi, ...be16(s.lids.length)];
  for (const l of s.lids) b.push(...be32(l));
  return Uint8Array.from(b);
}

function staiObject(classRel: number, stais: StaiDef[], plain: boolean): PObject {
  const o = new PObject(classRel, Ids.MultipleSTAI_Class_Rid, 0);
  if (plain) {
    o.addAttribute(Ids.MultipleSTAI_STAIs, new ValueBlob(0, staiBytes(stais[0])));
  } else {
    const m = new Map<number, { blobRootId: number; value: Uint8Array }>();
    for (const s of stais) m.set(s.alid, { blobRootId: 0, value: staiBytes(s) });
    o.addAttribute(Ids.MultipleSTAI_STAIs, new ValueBlobSparseArray(m));
  }
  return o;
}

/** Answer object of Explore 0x8A7E0000 (recursive). */
export function asAlarmsObject(m: AlarmModel): PObject {
  const root = new PObject(AS_ALARMS_REL, 0x1f00, 0);
  // an unrelated child before the MultipleSTAI one (the client picks the first MultipleSTAI class object)
  const other = new PObject(0x8a7e0001, 7860, 0);
  other.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("ASAlarmConfig"));
  root.addObject(other);
  const stais = m.stais.filter((s) => s.relationId === AS_ALARMS_REL);
  root.addObject(staiObject(0x8a7e0002, stais, false));
  return root;
}

/** Answer object of Explore thePLCProgram with the STAI attributes (user program alarms). */
export function alarmProgramObject(m: AlarmModel): PObject {
  const prog = new PObject(Ids.NativeObjects_thePLCProgram_Rid, Ids.PLCProgram_Class_Rid, 0);
  const rels = [...new Set(m.stais.filter((s) => s.relationId !== AS_ALARMS_REL).map((s) => s.relationId))];
  for (const rel of rels) {
    const blk = new PObject(rel, rel >= 0x8a0e0000 ? Ids.DB_Class_Rid : 0x9999, 0);
    blk.addAttribute(Ids.ObjectVariableTypeParentObject, new ValueUDInt(Ids.NativeObjects_thePLCProgram_Rid));
    blk.addObject(staiObject(1, m.stais.filter((s) => s.relationId === rel), m.userStaisAsPlainBlob));
    prog.addObject(blk);
  }
  for (const rel of m.blocksWithoutAlarms) {
    const blk = new PObject(rel, 0x9999, 0);
    blk.addAttribute(Ids.ObjectVariableTypeParentObject, new ValueUDInt(Ids.NativeObjects_thePLCProgram_Rid));
    prog.addObject(blk);
  }
  return prog;
}

// ----------------------------------------------------------------------------------------------------------------
// text library
// ----------------------------------------------------------------------------------------------------------------

class Le {
  readonly bytes: number[] = [];
  get pos(): number {
    return this.bytes.length;
  }
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number): void {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  raw(b: number[]): void {
    this.bytes.push(...b);
  }
}

/** The three offset tables and the string area for one language. */
export function textLibrary(m: AlarmModel, lang: number): { offsets: [Uint8Array, Uint8Array, Uint8Array]; strings: Uint8Array } | null {
  const entries: Array<{ relationId: number; alid: number; texts: AlarmTextSet }> = [];
  for (const s of m.stais) if (s.texts[lang]) entries.push({ relationId: s.relationId, alid: s.alid, texts: s.texts[lang] });
  for (const o of m.orphanTexts) if (o.texts[lang]) entries.push({ relationId: o.relationId, alid: o.alid, texts: o.texts[lang] });
  if (![LANG_DE, LANG_EN, LANG_FR].includes(lang)) return null; // no text library for this language
  const strings = new Le();
  const t3 = new Le();
  const t2 = new Le();
  const t1 = new Le();
  const relids = [...new Set(entries.map((e) => e.relationId))];
  // table 3: per alarm a list of (type index, offset into the string area)
  const t3Off = new Map<string, number>();
  for (const e of entries) {
    const items: Array<[number, number]> = [];
    const addText = (idx: number, s: string | undefined): void => {
      if (s === undefined) return;
      const b = [...Buffer.from(s, "utf8")];
      items.push([idx, strings.pos]);
      strings.u16(b.length);
      strings.raw(b);
    };
    addText(0, e.texts.info);
    addText(1, e.texts.alarm);
    (e.texts.additional ?? []).forEach((s, i) => addText(2 + i, s));
    if (e.texts.unknown) {
      items.push([255, strings.pos]);
      strings.u16(e.texts.unknown[0]);
      strings.u16(e.texts.unknown[1]);
    }
    t3Off.set(`${e.relationId}:${e.alid}`, t3.pos);
    t3.u32(items.length);
    for (const [idx, off] of items) {
      t3.u8(idx);
      t3.u32(off);
    }
  }
  // table 2: per relation id a list of (alid, offset into table 3)
  const t2Off = new Map<number, number>();
  for (const rel of relids) {
    const es = entries.filter((e) => e.relationId === rel);
    t2Off.set(rel, t2.pos);
    t2.u32(es.length);
    for (const e of es) {
      t2.u16(e.alid);
      t2.u32(t3Off.get(`${rel}:${e.alid}`)!);
    }
  }
  // table 1: 16 unknown bytes, count, (relation id, offset into table 2)
  t1.raw(Array.from({ length: 16 }, (_, i) => i));
  t1.u32(relids.length);
  for (const rel of relids) {
    t1.u32(rel);
    t1.u32(t2Off.get(rel)!);
  }
  return { offsets: [Uint8Array.from(t1.bytes), Uint8Array.from(t2.bytes), Uint8Array.from(t3.bytes)], strings: Uint8Array.from(strings.bytes) };
}

/** Answer object of Explore 0x8A360000 + language id (null = no such language). */
export function textLibraryObject(m: AlarmModel, lang: number): PObject | null {
  const lib = textLibrary(m, lang);
  if (lib === null) return null;
  const o = new PObject(TEXT_LIBRARY_BASE + lang, Ids.TextLibraryClassRID, 0);
  o.addAttribute(
    Ids.TextLibraryOffsetArea,
    new AlarmBlobArray(lib.offsets.map((b) => ({ rootId: 0, bytes: b }))),
  );
  o.addAttribute(Ids.TextLibraryStringArea, new ValueBlob(0, lib.strings));
  return o;
}

// ----------------------------------------------------------------------------------------------------------------
// active alarms
// ----------------------------------------------------------------------------------------------------------------

function cgsStruct(id: number, c: CgsDef): ValueStruct {
  const cgs = new ValueStruct(id);
  cgs.addStructElement(Ids.AS_CGS_AllStatesInfo, new ValueUSInt(c.allStatesInfo));
  cgs.addStructElement(Ids.AS_CGS_Timestamp, new ValueTimestamp(c.timestamp));
  cgs.addStructElement(Ids.AS_CGS_AssociatedValues, new AlarmBlobArray(c.associated));
  cgs.addStructElement(Ids.AS_CGS_AckTimestamp, new ValueTimestamp(c.ackTimestamp));
  return cgs;
}

/** text blob keys: (language id << 16) | text id (1 = info, 2 = alarm text, 3..11 = additional text 1..9) */
export function alarmTextsValue(texts: Record<number, AlarmTextSet>): ValueBlobSparseArray {
  const map = new Map<number, { blobRootId: number; value: Uint8Array }>();
  for (const [langS, t] of Object.entries(texts)) {
    const lang = Number(langS);
    const put = (id: number, s: string | undefined): void => {
      if (s !== undefined) map.set(((lang << 16) | id) >>> 0, { blobRootId: 0, value: new Uint8Array(Buffer.from(s, "utf8")) });
    };
    put(1, t.info);
    put(2, t.alarm);
    (t.additional ?? []).forEach((s, i) => put(3 + i, s));
  }
  return new ValueBlobSparseArray(map);
}

/** DAI object for one active alarm containing only the requested attributes (like the PLC does). */
export function daiObject(a: ActiveAlarmDef, requested: number[], omit: number[]): PObject {
  const o = new PObject(a.objectId, Ids.DAI_Class_Rid, 0);
  const all: Array<[number, PValue | null]> = [
    [Ids.ObjectVariableTypeName, new ValueWString(a.name)],
    [Ids.DAI_CPUAlarmID, new ValueLWord(a.cpuAlarmId)],
    [Ids.DAI_AllStatesInfo, new ValueUSInt(a.allStatesInfo)],
    [Ids.DAI_AlarmDomain, new ValueUInt(a.alarmDomain)],
    [Ids.DAI_MessageType, new ValueDInt(a.messageType)],
    [Ids.DAI_HmiInfo, new ValueBlob(0, Uint8Array.from(hmiInfoBytes(a.hmi)))],
    [Ids.DAI_SequenceCounter, new ValueUDInt(a.sequenceCounter)],
    [Ids.DAI_Coming, a.coming ? cgsStruct(Ids.DAI_Coming, a.coming) : null],
    [Ids.DAI_Going, a.going ? cgsStruct(Ids.DAI_Going, a.going) : null],
    [Ids.DAI_AlarmTexts_Rid, alarmTextsValue(a.texts)],
  ];
  for (const [id, v] of all) {
    if (v !== null && requested.includes(id) && !omit.includes(id)) o.addAttribute(id, v);
  }
  return o;
}

export function activeAlarmObjects(m: AlarmModel, requested: number[]): PObject[] {
  const objs = m.active.map((a) => daiObject(a, requested, m.omitActiveAttributes));
  if (m.oddActive && m.active.length > 0) {
    // neither DAI.Coming nor DAI.Going: the C# code adds null to the list
    objs.splice(1, 0, daiObject({ ...m.active[0], objectId: 0x10ff, name: "DAI_Odd", coming: undefined, going: undefined }, requested, m.omitActiveAttributes));
  }
  return objs;
}

export function serializeObject(o: PObject): Uint8Array {
  const b = new ByteStream();
  o.serialize(b);
  return b.toArray();
}
