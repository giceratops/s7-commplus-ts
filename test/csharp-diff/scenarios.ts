/*
 * Scenarios shared by the C# differential harness (tools/c-sharp-net-driver) and test/csharp-diff.test.ts.
 *
 * Every scenario has a C# twin in tools/c-sharp-net-driver/Program.cs that executes the same calls with the original C#
 * driver. Both sides produce a list of "steps" (plain JSON), and the mock PLC records the request PDUs it received
 * (after TLS decryption), which `recordRequests` normalises into a comparable list.
 */
import {
  Ids, ItemAddress, PObject, PlcTagByteArray, PlcTagBool, PlcTagByte, PlcTagDInt, PlcTagDWord, PlcTagInt, PlcTagIntArray,
  PlcTagLInt, PlcTagLReal, PlcTagReal, PlcTagString, PlcTagUDInt, PlcTagUSInt, PlcTagWord, S7CommPlusConnection, Softdatatype, ValueBlob,
  ValueBlobSparseArray, ValueDInt, ValueInt, ValueLWord, ValueStruct, ValueTimestamp, ValueUDInt, ValueUInt, ValueUSInt, ValueWString,
} from "../../src/index.js";
import type { PlcTag, PValue } from "../../src/index.js";
import { MockPlc } from "../mock-plc/MockPlc.js";
import type { MockPlcOptions } from "../mock-plc/MockPlc.js";
import type { ParsedRequest } from "../mock-plc/messages.js";
import { AlarmBlobArray, buildAlarmNotification } from "../mock-plc/messages.js";
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Step = { step: string } & { [k: string]: Json };

export interface ScenarioDef {
  /** mock PLC options */
  plc: Partial<MockPlcOptions>;
  password?: string;
  username?: string;
  /** connect to a port nobody listens on */
  refused?: boolean;
}

const FW31 = "1;6ES7 511-1AK02-0AB0;V3.1";
const FW29 = "1;6ES7 511-1AK02-0AB0;V2.9";

const base = { fixedChallenge: true };

/** the read of "Other.value" after login (the SystemLimits read during connect has another access area) */
function isDbRead(r: ParsedRequest): boolean {
  return r.kind === "GetMultiVariables" && r.addresses.some((a) => a.accessArea === 0x8a0e0002);
}

export const SCENARIOS: Record<string, ScenarioDef> = {
  connect: { plc: { ...base } },
  "legit-legacy": { plc: { ...base, firmware: FW29, password: "s3cret" }, password: "s3cret" },
  "legit-new": { plc: { ...base, firmware: FW31, password: "pw-123" }, password: "pw-123" },
  "legit-new-user": { plc: { ...base, firmware: FW31, password: "x", users: new Map([["alice", "Wonder!"]]) }, password: "Wonder!", username: "alice" },
  "legit-denied-legacy": { plc: { ...base, firmware: FW29, password: "s3cret" }, password: "wrong" },
  "legit-denied-new": { plc: { ...base, firmware: FW31, password: "s3cret" }, password: "wrong" },
  "legit-unprotected": { plc: { ...base }, password: "ignored" },
  "legit-none-protected": { plc: { ...base, firmware: FW31, password: "s3cret" } },
  browse: { plc: { ...base } },
  symbols: { plc: { ...base } },
  readwrite: { plc: { ...base } },
  // same calls, different framing of the PLC's answers (S7+ fragments, COTP TPDUs, TCP segments, TLS records)
  "readwrite-fragmented": { plc: { ...base, maxFragmentData: 97, tpduPayloadMax: 61 } },
  "readwrite-tcp5": { plc: { ...base, tcpSegmentSize: 5 } },
  "browse-coalesced": { plc: { ...base, fragmentWrite: "coalesced" } },
  "browse-split": { plc: { ...base, fragmentWrite: "split" } },
  // error paths: the numeric error codes (and that the client neither hangs nor crashes) must match
  "err-refused": { plc: { ...base }, refused: true },
  "err-cc-none": { plc: { ...base, cc: "none" } },
  "err-cc-close": { plc: { ...base, cc: "close" } },
  "err-cc-wrongtype": { plc: { ...base, cc: "wrongType" } },
  "err-cc-wrongsize": { plc: { ...base, cc: "wrongSize" } },
  "err-initssl-none": { plc: { ...base, initSsl: "none" } },
  "err-initssl-error": { plc: { ...base, initSsl: "error" } },
  "err-initssl-errresp": { plc: { ...base, initSsl: "errorResponse" } },
  "err-tls-garbage": { plc: { ...base, tls: "garbage" } },
  "err-tls-close": { plc: { ...base, tls: "close" } },
  "err-createobject-error": { plc: { ...base, onRequest: (r) => (r.kind === "CreateObject" ? { error: true } : undefined) } },
  "err-createobject-drop": { plc: { ...base, onRequest: (r) => (r.kind === "CreateObject" ? { drop: true } : undefined) } },
  "err-setmulti-error": { plc: { ...base, onRequest: (r) => (r.kind === "SetMultiVariables" ? { error: true } : undefined) } },
  "err-read-drop": { plc: { ...base, onRequest: (r) => (isDbRead(r) ? { drop: true } : undefined) } },
  "err-read-error": { plc: { ...base, onRequest: (r) => (isDbRead(r) ? { error: true } : undefined) } },
  "err-read-close": { plc: { ...base, onRequest: (r) => (isDbRead(r) ? { close: true } : undefined) } },
  "err-delete-drop": { plc: { ...base, onRequest: (r) => (r.kind === "DeleteObject" ? { drop: true } : undefined) } },
  limits: { plc: { ...base, tagsPerReadRequestMax: 3, tagsPerWriteRequestMax: 2 } },
  misc: { plc: { ...base } },
  subscription: { plc: { ...base } },
  alarm: { plc: { ...base } },
};

export interface RunCtx {
  host: string;
  port: number;
  plc: MockPlc;
  def: ScenarioDef;
  /** captured console output of the driver */
  log: string[];
}

// ----------------------------------------------------------------------------------------------------------------
// commands the C# harness asks the orchestrator to perform on the mock PLC (the TS scenarios call them directly)
// ----------------------------------------------------------------------------------------------------------------

export type PlcCommand =
  | { op: "setValue"; key: string; type: "int"; value: number }
  | { op: "waitCredit" }
  | { op: "alarm" };

export async function applyPlcCommand(plc: MockPlc, cmd: PlcCommand): Promise<void> {
  switch (cmd.op) {
    case "setValue":
      plc.setValue(cmd.key, new ValueInt(cmd.value));
      break;
    case "waitCredit": {
      // the client raises the credit limit with a no-response SetVariable: wait until the mock has seen it
      const c = [...plc.connections][0];
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const sub = c.subscription(c.subscriptionIds[0]);
        if (sub && sub.creditLimit === 15) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      break;
    }
    case "alarm": {
      const c = [...plc.connections][0];
      await c.sendRawNotification(buildAlarmNotification(c.subscriptionIds[0], 0, 0, makeAlarmObject()));
      break;
    }
  }
}

function makeAlarmObject(): PObject {
  const o = new PObject(0x1234, Ids.DAI_Class_Rid, 0);
  o.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("DAI_Test"));
  o.addAttribute(Ids.DAI_CPUAlarmID, new ValueLWord(0x1122334455667788n));
  o.addAttribute(Ids.DAI_AllStatesInfo, new ValueUSInt(0x05));
  o.addAttribute(Ids.DAI_AlarmDomain, new ValueUInt(3));
  o.addAttribute(Ids.DAI_MessageType, new ValueDInt(7));
  o.addAttribute(
    Ids.DAI_HmiInfo,
    new ValueBlob(0, Uint8Array.from([0x01, 0x02, 0x00, 0x01, 0x00, 0x00, 0xaa, 0xbb, 0x04, 0, 0, 0, 0x01, 0x02, 9, 8, 7])),
  );
  o.addAttribute(Ids.DAI_SequenceCounter, new ValueUDInt(77));
  const cgs = new ValueStruct(Ids.DAI_Coming);
  cgs.addStructElement(Ids.AS_CGS_AllStatesInfo, new ValueUSInt(1));
  cgs.addStructElement(Ids.AS_CGS_Timestamp, new ValueTimestamp(1_700_000_000_000_000_000n));
  cgs.addStructElement(
    Ids.AS_CGS_AssociatedValues,
    new AlarmBlobArray([
      { rootId: Ids.AS_CGS_AssociatedValues, bytes: Uint8Array.from([0, 1, 0, 0]) },
      { rootId: Ids.TI_INT, bytes: Uint8Array.from([0xff, 0xfe]) },
      { rootId: Ids.TI_DINT, bytes: Uint8Array.from([0x00, 0x00, 0x01, 0x00]) },
      { rootId: Ids.TI_BOOL, bytes: Uint8Array.from([1]) },
      { rootId: 0x020a0000 + 20, bytes: Uint8Array.from([20, 5, ...Buffer.from("hello")]) },
    ]),
  );
  cgs.addStructElement(Ids.AS_CGS_AckTimestamp, new ValueTimestamp(0n));
  o.addAttribute(Ids.DAI_Coming, cgs);
  const texts = new Map([
    [0x04070001, { blobRootId: 0, value: Buffer.from("Info text DE") as unknown as Uint8Array }],
    [0x04070002, { blobRootId: 0, value: Buffer.from("Motor overload") as unknown as Uint8Array }],
    [0x04090002, { blobRootId: 0, value: Buffer.from("Motor overload (en)") as unknown as Uint8Array }],
  ]);
  o.addAttribute(Ids.DAI_AlarmTexts_Rid, new ValueBlobSparseArray(texts));
  return o;
}

// ----------------------------------------------------------------------------------------------------------------
// helpers mirroring Program.cs
// ----------------------------------------------------------------------------------------------------------------

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function describe(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return (v as object).constructor.name + " " + (v as { toString(): string }).toString();
}

function tagLine(t: PlcTag): string {
  return `${t.name} | q=${t.quality} | ${t.toString()} | re=${t.lastReadError} | we=${t.lastWriteError}`;
}

type AnyTag = PlcTag & { value: any };

class Rec {
  readonly steps: Step[] = [];
  step(name: string, kv: { [k: string]: Json } = {}): void {
    this.steps.push({ step: name, ...kv });
  }
}

async function connect(ctx: RunCtx, r: Rec): Promise<S7CommPlusConnection | null> {
  const conn = new S7CommPlusConnection();
  conn.plcPort = ctx.port;
  const res = await conn.connect(ctx.host, ctx.def.password ?? "", ctx.def.username ?? "", 3000);
  r.step("connect", { res });
  if (res !== 0) {
    try {
      conn.client?.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
  return conn;
}

async function tag(conn: S7CommPlusConnection, r: Rec, sym: string): Promise<PlcTag | null> {
  try {
    return await conn.getPlcTagBySymbol(sym);
  } catch (e) {
    r.step("tag-exception:" + sym, { message: (e as Error).message });
    return null;
  }
}

async function disc(conn: S7CommPlusConnection, r: Rec): Promise<void> {
  await conn.disconnect();
  r.step("disconnect", { sessionId: conn.sessionId });
}

const SYMBOL_CASES = [
  "TestDB.counter", '"TestDB".counter', "TestDB.samples[2]", "TestDB.samples", "TestDB.motor.speed", "Other.value",
  "TestDB.doesNotExist", "NoSuchDb.x", "TestDB.samples[9]", "TestDB.motor.running", "TestDB.bytes",
];

const READ_NAMES = [
  "TestDB.flag", "TestDB.counter", "TestDB.bigNumber", "TestDB.temperature", "TestDB.name", "TestDB.samples[1]",
  "TestDB.samples", "TestDB.motor.speed", "TestDB.motor.running", "TestDB.motor.mode", "TestDB.word", "TestDB.dword",
  "TestDB.lreal", "TestDB.lint", "TestDB.usint", "TestDB.udint", "Other.value",
];

type Fn = (ctx: RunCtx, r: Rec) => Promise<void>;

const legit: Fn = async (ctx, r) => {
  const c = await connect(ctx, r);
  if (!c) return;
  const { res, values, errors } = await c.readValues([new ItemAddress("8A0E0002.A")]);
  r.step("read-after-login", { res, values: values.map(describe), errors: errors.map(String) });
  await disc(c, r);
};

const browseFn: Fn = async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    const dbRes = await c.getListOfDatablocks();
    r.step("datablocks", {
      res: dbRes.res, dbs: dbRes.dbInfoList.map((d) => [d.db_name, d.db_number, d.db_block_relid, d.db_block_ti_relid].join("|")),
    });
    const { res, varInfoList } = await c.browse();
    const lines = varInfoList.map((v) =>
      [v.name, v.accessSequence, v.softdatatype, v.optAddress, v.optBitoffset, v.nonOptAddress, v.nonOptBitoffset].join("|"),
    );
    r.step("browse", {
      res, count: lines.length, sha256: sha256Hex(lines.join("\n")), head: lines.slice(0, 25), tail: lines.slice(Math.max(0, lines.length - 3)),
    });
    await disc(c, r);
};

const readwriteFn: Fn = async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    const tags: PlcTag[] = [];
    for (const n of READ_NAMES) tags.push((await tag(c, r, n))!);
    let res = await c.readTags(tags);
    r.step("read-all", { res, tags: tags.map(tagLine) });

    const mk = async <T extends PlcTag>(s: string): Promise<T & { value: any }> => (await tag(c, r, s)) as T & { value: any };
    const flag = await mk<PlcTagBool>("TestDB.flag");
    const counter = await mk<PlcTagInt>("TestDB.counter");
    const big = await mk<PlcTagDInt>("TestDB.bigNumber");
    const temp = await mk<PlcTagReal>("TestDB.temperature");
    const name = await mk<PlcTagString>("TestDB.name");
    const smp = await mk<PlcTagIntArray>("TestDB.samples");
    const speed = await mk<PlcTagLReal>("TestDB.motor.speed");
    const word = await mk<PlcTagWord>("TestDB.word");
    const dword = await mk<PlcTagDWord>("TestDB.dword");
    const lint = await mk<PlcTagLInt>("TestDB.lint");
    const usint = await mk<PlcTagUSInt>("TestDB.usint");
    const udint = await mk<PlcTagUDInt>("TestDB.udint");
    const mode = await mk<PlcTagByte>("TestDB.motor.mode");
    flag.value = false;
    counter.value = 32767;
    big.value = -2147483648;
    temp.value = -273.15;
    name.value = "Grüße vom Test";
    smp.value = [-1, 0, 1, 32767];
    speed.value = 1e300;
    word.value = 0x1234;
    dword.value = 0xffffffff;
    lint.value = 9223372036854775807n;
    usint.value = 255;
    udint.value = 123;
    mode.value = 0xaa;
    const all: AnyTag[] = [flag, counter, big, temp, name, smp, speed, word, dword, lint, usint, udint, mode];
    res = await c.writeTags(all);
    r.step("write-all", { res, errors: all.map((t) => `${t.name}=${t.lastWriteError}`) });
    const fresh: PlcTag[] = [];
    for (const t of all) fresh.push((await tag(c, r, t.name))!);
    res = await c.readTags(fresh);
    r.step("readback", { res, tags: fresh.map(tagLine) });

    const st = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
    st.value = "twenty chars string!";
    const bytes = (await tag(c, r, "TestDB.bytes")) as PlcTagByteArray;
    const bv = Uint8Array.from({ length: 2000 }, (_, i) => (i * 13 + 5) & 0xff);
    bytes.value = bv;
    res = await c.writeTags([st, bytes]);
    r.step("write-big", { res, stErr: String(st.lastWriteError), bytesErr: String(bytes.lastWriteError) });
    const st2 = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
    const b2 = (await tag(c, r, "TestDB.bytes")) as PlcTagByteArray;
    res = await c.readTags([st2, b2]);
    r.step("read-big", {
      res, str: st2.value, bytesSha: sha256Hex(Buffer.from(b2.value).toString("base64")), bytesEqual: Buffer.from(b2.value).equals(Buffer.from(bv)),
    });

    const wrong = new PlcTagDInt("wrong", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_DINT);
    wrong.value = 5;
    const good = (await tag(c, r, "TestDB.counter")) as PlcTagInt;
    good.value = 77;
    res = await c.writeTags([wrong, good]);
    r.step("write-wrongtype", { res, wrongErr: String(wrong.lastWriteError), goodErr: String(good.lastWriteError) });
    const missing = new PlcTagInt("missing", new ItemAddress("8A0E0001.99"), Softdatatype.S7COMMP_SOFTDATATYPE_INT);
    const ok = (await tag(c, r, "TestDB.counter"))!;
    res = await c.readTags([missing, ok]);
    r.step("read-missing", { res, tags: [missing, ok].map(tagLine) });
    const mism = new PlcTagReal("mism", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_REAL);
    res = await c.readTags([mism]);
    r.step("read-mismatch", { res, tags: [mism].map(tagLine) });
    await disc(c, r);
};

const RUN: Record<string, Fn> = {
  browse: browseFn,
  "browse-coalesced": browseFn,
  "browse-split": browseFn,
  readwrite: readwriteFn,
  "readwrite-fragmented": readwriteFn,
  "readwrite-tcp5": readwriteFn,
  connect: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    const cr = c.commResources;
    r.step("session", {
      sessionId: c.sessionId, sessionId2: c.sessionId2, tagsRead: cr.tagsPerReadRequestMax, tagsWrite: cr.tagsPerWriteRequestMax,
      subsMax: cr.plcSubscriptionsMax, attrMax: cr.plcAttributesMax, subMemMax: cr.subscriptionMemoryMax,
    });
    await disc(c, r);
  },
  "legit-legacy": legit,
  "legit-new": legit,
  "legit-new-user": legit,
  "legit-denied-legacy": legit,
  "legit-denied-new": legit,
  "legit-unprotected": legit,
  "legit-none-protected": legit,
  ...Object.fromEntries(Object.keys(SCENARIOS).filter((n) => n.startsWith("err-")).map((n) => [n, legit])),
  symbols: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    for (const s of SYMBOL_CASES) {
      const t = await tag(c, r, s);
      r.step("symbol:" + s, { tag: t === null ? "null" : `${t.constructor.name} ${t.address.getAccessString()} ${t.datatype}` });
    }
    await disc(c, r);
  },
  limits: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    r.step("limits", { read: c.commResources.tagsPerReadRequestMax, write: c.commResources.tagsPerWriteRequestMax });
    const addrs = ["8A0E0001.A", "8A0E0001.B", "8A0E0001.C", "8A0E0001.D", "8A0E0001.99", "8A0E0001.11", "8A0E0002.A"].map((a) => new ItemAddress(a));
    const rd = await c.readValues(addrs);
    r.step("read", { res: rd.res, values: rd.values.map(describe), errors: rd.errors.map(String) });
    const waddrs = ["8A0E0001.B", "8A0E0001.C", "8A0E0001.99", "8A0E0001.11", "8A0E0001.A"].map((a) => new ItemAddress(a));
    const vals: PValue[] = [new ValueInt(1), new ValueDInt(2), new ValueInt(3), new ValueInt(4), new ValueDInt(5)];
    const w = await c.writeValues(waddrs, vals);
    r.step("write", { res: w.res, errors: w.errors.map(String) });
    await disc(c, r);
  },
  misc: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    const cm = await c.getCommentsXml(0x8a0e0001);
    r.step("comments", { res: cm.res, line: cm.xmlLinecomment, db: cm.xmlDbcomment });
    r.step("opstate", { res: await c.setPlcOperatingState(3) });
    await disc(c, r);
  },
  subscription: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    const counter = (await tag(c, r, "TestDB.counter")) as PlcTagInt;
    const temp = (await tag(c, r, "TestDB.temperature")) as PlcTagReal;
    const arr = (await tag(c, r, "TestDB.samples[1]")) as PlcTagInt;
    const tags = [counter, temp, arr];
    r.step("subscribe", { res: await c.subscriptionCreate(tags, 100) });
    r.step("initial-notification", { res: await c.testWaitForVariableChangeNotifications(1), tags: tags.map(tagLine) });
    await applyPlcCommand(ctx.plc, { op: "setValue", key: "8A0E0001.B", type: "int", value: 4711 });
    r.step("change-notification", { res: await c.testWaitForVariableChangeNotifications(1), tags: tags.map(tagLine) });
    for (let i = 0; i < 8; i++) {
      await applyPlcCommand(ctx.plc, { op: "setValue", key: "8A0E0001.B", type: "int", value: 5000 + i });
      r.step("change-notification-" + i, { res: await c.testWaitForVariableChangeNotifications(1), counter: counter.toString() });
    }
    await applyPlcCommand(ctx.plc, { op: "waitCredit" });
    r.step("unsubscribe", { res: await c.subscriptionDelete() });
    await disc(c, r);
  },
  alarm: async (ctx, r) => {
    const c = await connect(ctx, r);
    if (!c) return;
    r.step("alarm-subscribe", { res: await c.alarmSubscriptionCreate() });
    ctx.log.length = 0;
    const waiting = c.testWaitForAlarmNotifications(3000, 1, 1031);
    await applyPlcCommand(ctx.plc, { op: "alarm" });
    const res = await waiting;
    r.step("alarm-notification", { res, dai: daiLines(ctx.log.join("\n")) });
    r.step("alarm-unsubscribe", { res: await c.alarmSubscriptionDelete() });
    await disc(c, r);
  },
};

/** The lines of the driver output that dump the decoded alarm (identical filter in Program.cs) */
export function daiLines(log: string): string[] {
  return log.split("\n").filter((l) => l.trimStart().startsWith("<") || l.includes("AlarmText"));
}

/** Runs one scenario with the TS client against `ctx.plc`. */
export async function runTsScenario(name: string, ctx: RunCtx): Promise<Step[]> {
  const r = new Rec();
  await RUN[name](ctx, r);
  return JSON.parse(JSON.stringify(r.steps, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// ----------------------------------------------------------------------------------------------------------------
// recording of the mock PLC side
// ----------------------------------------------------------------------------------------------------------------

export interface RecordedRequest {
  kind: string;
  version: number;
  functionCode: number;
  sequenceNumber: number;
  sessionId: number;
  transportFlags: number;
  integrityId: number | null;
  fragments: number;
  /** request PDU bytes as received, hex (the new-login ciphertext, which depends on the TLS exporter secret, is masked) */
  hex: string;
}

export interface RecordedLegit {
  kind: string;
  challenge: string;
  /** legacy login: hex of the response, new login: masked (depends on the TLS exporter secret) */
  blob: string;
  payloadType: number | null;
  username: string | null;
  password: string | null;
  ok: boolean;
}

export interface MockRecording {
  requests: RecordedRequest[];
  legitimations: RecordedLegit[];
  crInfos: Array<{ localTsap: number; remoteTsap: string }>;
  tls: Array<{ protocol: string | null }>;
  violations: string[];
  writes: Array<{ key: string; type: string; value: string }>;
  operatingState: number | null;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function recordMock(plc: MockPlc): MockRecording {
  const blobs = plc.legitimations.filter((l) => l.kind === "new").map((l) => hex(l.blob));
  const requests = plc.requests.map((req, i): RecordedRequest => {
    let h = hex(plc.rawRequests[i].data);
    for (const b of blobs) if (b.length > 0) h = h.split(b).join("<NEW-LOGIN-CIPHERTEXT>");
    return {
      kind: req.kind, version: req.version, functionCode: req.functionCode, sequenceNumber: req.sequenceNumber, sessionId: req.sessionId,
      transportFlags: req.transportFlags, integrityId: req.integrityId, fragments: plc.rawRequests[i].fragments, hex: h,
    };
  });
  return {
    requests,
    legitimations: plc.legitimations.map((l) => ({
      kind: l.kind, challenge: hex(l.challenge), blob: l.kind === "new" ? "<NEW-LOGIN-CIPHERTEXT>" : hex(l.blob),
      payloadType: l.payloadType, username: l.username, password: l.password, ok: l.ok,
    })),
    crInfos: plc.crInfos.map((c) => ({ ...c })),
    tls: plc.tlsInfo.map((t) => ({ protocol: t.protocol })),
    violations: [...plc.violations],
    writes: plc.writes.map((w) => ({ key: w.key, type: w.value.constructor.name, value: w.value.toString() })),
    operatingState: plc.operatingState,
  };
}

/** Starts a mock PLC for a scenario. */
export async function startScenarioPlc(name: string): Promise<MockPlc> {
  const plc = new MockPlc(SCENARIOS[name].plc);
  await plc.start();
  return plc;
}

/** The port the client under test connects to (a closed one for the "refused" scenario). */
export async function clientPort(name: string, plc: MockPlc): Promise<number> {
  return SCENARIOS[name].refused ? await MockPlc.unusedPort() : plc.port;
}

// console.log of the driver is captured while TS scenarios run (reference counted: scenarios may run concurrently)
const captured: string[] = [];
let captureUsers = 0;
let origLog: typeof console.log | null = null;
function captureStart(): void {
  if (captureUsers++ === 0) {
    origLog = console.log;
    console.log = (...a: unknown[]): void => void captured.push(a.join(" "));
  }
}
function captureEnd(): void {
  if (--captureUsers === 0 && origLog) console.log = origLog;
}

/** Runs a scenario with the TS client against a fresh mock PLC and returns what the client saw and what the mock received. */
export async function runTsRecording(name: string): Promise<{ steps: Step[]; mock: MockRecording }> {
  const plc = await startScenarioPlc(name);
  captureStart();
  try {
    const steps = await runTsScenario(name, { host: "127.0.0.1", port: await clientPort(name, plc), plc, def: SCENARIOS[name], log: captured });
    await new Promise((r) => setTimeout(r, 50));
    return { steps, mock: recordMock(plc) };
  } finally {
    captureEnd();
    await plc.stop();
  }
}
