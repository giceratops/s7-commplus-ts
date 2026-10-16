/**
 * Differential test against the original C# driver.
 *
 * test/golden.json.gz is produced by tools/golden-gen (C#, compiled from the unmodified original sources). It contains
 * input specs (objects to build, methods to call, byte streams to decode) and the results the C# driver produced
 * (serialized hex, ToString(), decoded field values, thrown-exception flag). This test interprets the same specs against
 * the TypeScript port and compares everything. See tools/golden-gen/README.md for how to regenerate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as S7 from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const gzPath = join(here, "golden.json.gz");
const jsonPath = join(here, "golden.json");
const golden: any = existsSync(gzPath)
  ? JSON.parse(gunzipSync(readFileSync(gzPath)).toString("utf8"))
  : JSON.parse(readFileSync(jsonPath, "utf8")); // (plain golden.json is accepted too, e.g. straight from the generator)

const S: any = S7;

// ---------------------------------------------------------------------------------------------------------------------
// Documented, intentional deviations of the port (see PORTING.md / src comments). Vectors matching are not compared.
// ---------------------------------------------------------------------------------------------------------------------
const KNOWN_DEVIATIONS: { re: RegExp; reason: string }[] = [
  {
    re: /^tag-(read|raw)\/PlcTagDateAndTimeArray-.*(bcd2|-2)$/,
    reason: "PlcTagDateAndTimeArray.processReadResult: C# reads the millisecond nibble of every element from v[7] (bug); the port uses v[pos + 7]. Only multi-element arrays are affected.",
  },
  {
    re: /^(tag\/PlcTag(String|WString|StringArray)-default|tag-read\/PlcTagStringArray-PlcTagStringArray-0|tag-raw\/PlcTagStringArray-raw2)$/,
    reason: "Uninitialised string tags: C# Value is null (GetWriteValue throws), the port initialises string tags with \"\"/[].",
  },
];

// ---------------------------------------------------------------------------------------------------------------------
const hex = (b: ArrayLike<number> | null | undefined): string | null =>
  b == null ? null : Array.from(b as ArrayLike<number>, (x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const lowerRun = (s: string) => s.replace(/^[A-Z]+(?![a-z])/, (m) => m.toLowerCase()).replace(/^[A-Z]+(?=[A-Z][a-z])/, (m) => m.toLowerCase());
const candidates = (n: string) => [...new Set([lowerFirst(n), lowerRun(n), n])];

function member(obj: any, name: string): string | null {
  for (const c of candidates(name)) if (c in obj) return c;
  return null;
}

function decode(n: any): any {
  if (n === null || n === undefined) return null;
  if (Array.isArray(n)) return n.map(decode);
  if (typeof n !== "object") return n;
  if ("$big" in n) return BigInt(n.$big);
  if ("$hex" in n) return fromHex(n.$hex);
  if ("$f" in n) return n.$f === "NaN" ? NaN : n.$f === "Infinity" ? Infinity : n.$f === "-Infinity" ? -Infinity : -0;
  if ("$dt" in n) { const a = n.$dt; return new Date(a[0], a[1] - 1, a[2], a[3], a[4], a[5], a[6] ?? 0); }
  if ("$map" in n) return new Map(n.$map.map(([k, v]: any) => [decode(k), decode(v)]));
  if ("$blobentry" in n) return { blobRootId: Number(decode(n.$blobentry[0])), value: decode(n.$blobentry[1]) };
  if ("$stream" in n) return new S7.ByteStream(fromHex(n.$stream));
  if ("$w" in n) return new S7.ByteStream();
  if ("$pv" in n) return S7.PValue.deserialize(new S7.ByteStream(fromHex(n.$pv)));
  if ("static" in n) return null;
  if ("new" in n) return build(n);
  throw new Error("cannot decode " + JSON.stringify(n));
}

function build(o: any): any {
  const C = S[o.new];
  if (!C) throw new Error("class not exported: " + o.new);
  const inst = new C(...(o.args ?? []).map(decode));
  if (o.set) for (const [k, v] of Object.entries(o.set)) {
    const m = member(inst, k);
    if (!m) throw new Error(`no member ${k} on ${o.new}`);
    inst[m] = decode(v);
  }
  if (o.do) for (const c of o.do) { const r = call(inst, o.new, c); if (r.err) throw new Error("setup call failed " + JSON.stringify(c) + " " + r.err); }
  return inst;
}

function dumpHex(v: any): string {
  try { const b = new S7.ByteStream(); v.serialize(b); return hex(b.toArray())!; } catch { return "<throws>"; }
}

/** Executes one "do" entry, returns the normalized result mirroring the C# Interp.CallMethod result */
function call(inst: any, clsName: string | null, c: any[], isStatic = false): any {
  const name: string = c[0];
  const res: any = {};
  try {
    if (name === "$serialize") {
      const b = new S7.ByteStream();
      res.ret = inst.serialize(b); res.hex = hex(b.toArray());
      return res;
    }
    if (name === "$toString") { res.str = inst.toString(); return res; }
    if (name === "$dump") { res.dump = inst; return res; }
    const rawArgs = c.slice(1);
    const args = rawArgs.map(decode);
    const writeStream = rawArgs.some((a) => a && typeof a === "object" && "$w" in a);
    let fn: string;
    const target: any = isStatic ? S[clsName!] : inst;
    const cand = candidates(name);
    if (isStatic && name === "ToString") cand.unshift("toStringValue");
    fn = cand.find((x) => typeof target[x] === "function")!;
    if (!fn) throw new Error(`no method ${name} on ${clsName}`);
    let r: any;
    const isS7p = clsName === "S7p";
    if (isS7p && name === "DecodeObject") {
      r = { out: [target.decodeObject(args[0], null, args[1] ?? false)] };
    } else if (isS7p && name === "DecodeHeader") {
      const h = target.decodeHeader(args[0]); r = { out: [h.version, h.length] };
    } else if (isS7p && name.startsWith("Decode")) {
      r = { out: [target[fn](...args)] };
    } else if (clsName && clsName.startsWith("POffsetInfoType") && name === "Deserialize") {
      const x = target[fn](...args); r = { ret: x.oi, out: [x.length] };
    } else {
      r = { ret: target[fn](...args) };
    }
    if ("ret" in r) res.ret = r.ret;
    if (r.out) res.out = r.out;
    const pos: number[] = [];
    for (const a of args) if (a instanceof S7.ByteStream && !writeStream) pos.push(a.position);
    if (writeStream) res.hex = hex(args.find((a: any) => a instanceof S7.ByteStream)!.toArray());
    if (pos.length) res.pos = pos;
    res.skipRet = name.startsWith("Decode") || name === "Deserialize";
  } catch (e: any) {
    return { err: String(e?.message ?? e) };
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// comparison: expected (C# dump) vs actual (JS object)
// ---------------------------------------------------------------------------------------------------------------------
const wall = (d: Date) => {
  const t = new Date(0);
  t.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
  t.setUTCHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return t.getTime() + 62135596800000;
};
/** ValueWString.serialize writes the UTF-8 byte length (documented deviation, C# writes the char count): for vectors with
 *  non-ASCII text the serialized bytes are not comparable. Decoded values / ToString are still compared. */
let skipHex = false;

function cmp(path: string, exp: any, act: any, errs: string[]): void {
  const fail = (m: string) => { errs.push(`${path}: ${m}`); };
  if (exp === null) {
    // documented deviations: TS decodeOctets returns an empty array where C# returns null (blob without data);
    // string tags are initialised with "" where C# has null.
    if (act != null && !(act instanceof Uint8Array && act.length === 0) && act !== "") fail(`expected null, got ${show(act)}`);
    return;
  }
  if (act === undefined || act === null) { fail(`expected ${show(exp)}, got ${act}`); return; }
  switch (typeof exp) {
    case "boolean": if (act !== exp) fail(`expected ${exp}, got ${show(act)}`); return;
    case "number":
      if (typeof act === "bigint") { if (act.toString() !== String(exp)) fail(`expected ${exp}, got ${act}`); }
      else if (act !== exp) fail(`expected ${exp}, got ${show(act)}`);
      return;
    case "string":
      if (typeof act === "bigint") { if (act.toString() !== exp) fail(`expected ${exp}, got ${act}`); }
      else if (act !== exp) fail(`expected ${show(exp)}, got ${show(act)}`);
      return;
  }
  if (Array.isArray(exp)) {
    const a = Array.isArray(act) || ArrayBuffer.isView(act) ? Array.from(act as any) : null;
    if (!a) { fail(`expected array, got ${show(act)}`); return; }
    if (a.length !== exp.length) { fail(`array length ${a.length} != ${exp.length}`); return; }
    exp.forEach((e, i) => cmp(`${path}[${i}]`, e, a[i], errs));
    return;
  }
  if ("$f" in exp) {
    const want = exp.$f === "NaN" ? NaN : exp.$f === "Infinity" ? Infinity : exp.$f === "-Infinity" ? -Infinity : -0;
    if (!Object.is(act, want) && !(Number.isNaN(want) && Number.isNaN(act))) fail(`expected ${exp.$f}, got ${show(act)}`);
    return;
  }
  if ("$hex" in exp) {
    const h = Array.isArray(act) || ArrayBuffer.isView(act) ? hex(act as any) : null;
    if (h !== exp.$hex) fail(`expected hex ${exp.$hex}, got ${h}`);
    return;
  }
  if ("$ms" in exp) {
    if (!(act instanceof Date)) { fail("expected Date"); return; }
    const w = wall(act);
    if (w !== exp.$ms) fail(`expected ${exp.$ms}ms, got ${w}ms`);
    return;
  }
  if ("$dict" in exp) {
    const entries: [any, any][] = act instanceof Map ? Array.from(act.entries()) : Object.entries(act);
    if (entries.length !== exp.$dict.length) { fail(`dict size ${entries.length} != ${exp.$dict.length}`); return; }
    exp.$dict.forEach(([k, v]: any, i: number) => {
      if (String(entries[i][0]) !== String(k)) fail(`dict key[${i}] ${entries[i][0]} != ${k}`);
      cmp(`${path}{${k}}`, v, entries[i][1], errs);
    });
    return;
  }
  const keys = Object.keys(exp);
  if (keys.length === 2 && "$str" in exp && "hex" in exp) {
    // PValue / PObject
    let s: string; try { s = act.toString(); } catch (e: any) { s = "<throws " + e?.name + ">"; }
    if (typeof exp.$str === "string" && exp.$str.startsWith("<throws")) { if (!s.startsWith("<throws")) fail("C# ToString threw, TS did not"); }
    else if (s !== exp.$str) fail(`toString differs:\n--- C#\n${exp.$str}\n--- TS\n${s}`);
    // NaN: JS numbers cannot carry the sign/payload bits of a decoded NaN, so a decoded-then-reserialized NaN may differ
    // from the original bit pattern (documented deviation); canonical NaN values are written as C# float.NaN/double.NaN.
    const nanPayload = typeof exp.$str === "string" && exp.$str.includes("NaN");
    if (!skipHex && !nanPayload && exp.hex !== "<throws>") {
      // (if C# cannot serialize the decoded object - e.g. blob with null data - there is nothing to compare)
      const h = dumpHex(act);
      if (h !== exp.hex) fail(`serialize hex TS ${h} != C# ${exp.hex}`);
    }
    return;
  }
  for (const k of keys) {
    if (k === "$str") {
      let s: string; try { s = act.toString(); } catch (e: any) { s = "<throws " + e?.name + ">"; }
      if (typeof exp.$str === "string" && exp.$str.startsWith("<throws")) { if (!s.startsWith("<throws")) fail("C# ToString threw, TS did not"); }
      else if (s !== exp.$str) fail(`toString differs:\n--- C#\n${exp.$str}\n--- TS\n${s}`);
      continue;
    }
    const m = member(act, k);
    if (!m) { fail(`missing member ${k}`); continue; }
    cmp(`${path}.${k}`, exp[k], act[m], errs);
  }
}
function show(v: any): string {
  if (typeof v === "bigint") return v + "n";
  if (v instanceof Uint8Array) return "u8:" + hex(v);
  try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x + "n" : x))?.slice(0, 200) ?? String(v); } catch { try { return String(v); } catch { return "<unprintable>"; } }
}

function runVector(v: any): string[] {
  const errs: string[] = [];
  skipHex = v.group !== "s7p" && /[^\x00-\x7f]/.test(JSON.stringify([v.obj, v.do, v.expect]));
  if (v.buildErr !== undefined) {
    try { if ("new" in v.obj) build(v.obj); errs.push("C# build failed (" + v.buildErr + ") but TS build succeeded"); } catch { /* both fail */ }
    return errs;
  }
  let inst: any = null; let cls: string | null = null; let isStatic = false;
  try {
    if ("static" in v.obj) { cls = v.obj.static; isStatic = true; }
    else { inst = build(v.obj); cls = v.obj.new; }
  } catch (e: any) {
    return ["TS build failed: " + (e?.message ?? e)];
  }
  v.do.forEach((c: any[], i: number) => {
    const exp = v.expect[i];
    const act = call(inst, cls, c, isStatic);
    const p = `${c[0]}`;
    if (exp.err !== undefined) { if (act.err === undefined) errs.push(`${p}: C# threw ${exp.err}, TS did not (result ${show(act.ret ?? act.out ?? act.str)})`); return; }
    if (act.err !== undefined) { errs.push(`${p}: TS threw "${act.err}", C# did not`); return; }
    if ("ret" in exp && !(act.skipRet && typeof exp.ret === "number")) cmp(`${p}.ret`, exp.ret, act.ret, errs);
    for (const k of ["out", "pos", "hex", "str", "dump"]) if (k in exp && !(k === "hex" && skipHex)) cmp(`${p}.${k}`, exp[k], act[k], errs);
    if ("ret" in exp && exp.ret !== null && !("ret" in act) && !act.skipRet) errs.push(`${p}: no ret`);
  });
  return errs;
}

// ---------------------------------------------------------------------------------------------------------------------
const groups = new Map<string, any[]>();
for (const v of golden.vectors) { if (process.env.GOLDEN_GROUP && !new RegExp(process.env.GOLDEN_GROUP).test(v.group)) continue; if (!groups.has(v.group)) groups.set(v.group, []); groups.get(v.group)!.push(v); }

describe("golden: constants", () => {
  for (const [cls, members] of Object.entries<any>(golden.constants)) {
    it(cls, () => {
      const bad: string[] = [];
      for (const [k, val] of Object.entries<any>(members)) {
        if ((S[cls] as any)?.[k] !== val) bad.push(`${cls}.${k}: C# ${val}, TS ${(S[cls] as any)?.[k]}`);
      }
      expect(bad).toEqual([]);
    });
  }
});

const report: string[] = [];
let compared = 0; let skipped = 0;
describe("golden: C# vs TS", () => {
  for (const [group, vecs] of groups) {
    it(`${group} (${vecs.length} vectors)`, () => {
      const bad: string[] = [];
      for (const v of vecs) {
        const id = `${group}/${v.id}`;
        if (KNOWN_DEVIATIONS.some((d) => d.re.test(id))) { skipped++; continue; }
        compared++;
        if (process.env.GOLDEN_TRACE) writeFileSync(process.env.GOLDEN_TRACE, id);
        let errs: string[];
        try { errs = runVector(v); } catch (e: any) { errs = ["test harness exception: " + (e?.stack ?? e)]; }
        if (errs.length) bad.push(`[${id}] ` + errs.join(" | "));
      }
      report.push(...bad);
      expect(bad.slice(0, 25).map((s) => s.slice(0, 1500)), `${bad.length} of ${vecs.length} vectors mismatched`).toEqual([]);
    }, 300_000);
  }
  it("summary", () => {
    if (process.env.GOLDEN_REPORT) writeFileSync(process.env.GOLDEN_REPORT, report.join("\n"));
    console.log(`golden vectors: ${golden.vectors.length}, compared: ${compared}, skipped (documented deviations): ${skipped}, mismatches: ${report.length}`);
  });
});
