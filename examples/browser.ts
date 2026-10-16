/*
 * Port of S7CommPlusGUIBrowser (Form1.cs / Program.cs, S7CommPlusDriver, Thomas Wiens) as a cross-platform
 * interactive terminal tool (REPL). Ported to TypeScript. Replaces the Windows-only WinForms GUI.
 * Usage: npx tsx examples/browser.ts <ip> [password] [user]
 * Type "help" for the commands. WARNING: write/state commands change the PLC, use with care.
 */
import { createInterface } from "node:readline";
import {
  AlarmData,
  ItemAddress,
  PlcTags,
  S7Client,
  S7CommPlusConnection,
  Softdatatype,
} from "../src/index.js";
import type { DatablockInfo, PlcTag } from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------------------------------------
// Tree (replaces the TreeView of Form1). tag === undefined: leaf, 0: array parent, else relation id (lazy load)
// ---------------------------------------------------------------------------------------------------------
interface Node {
  text: string;
  tag?: number;
  parent: Node | null;
  children: Node[] | null; // null = not loaded yet ("Loading..." placeholder in the GUI)
  kind: string; // image key of the GUI
}

const AREAS: Array<[string, number]> = [
  ["Inputs", 0x90010000],
  ["Outputs", 0x90020000],
  ["Merker", 0x90030000],
  ["S7Timers", 0x90050000],
  ["S7Counters", 0x90060000],
];

let conn: S7CommPlusConnection | null = null;
let root: Node = { text: "", parent: null, children: [], kind: "" };
let cwd: Node = root;
let dbInfos: DatablockInfo[] = [];

function status(s: string): void {
  console.log("[" + s + "]");
}

function imageKey(vte: any): string {
  const t = Softdatatype;
  const is = (...l: number[]): boolean => l.includes(vte.softdatatype);
  let sk = "Tag";
  if (is(t.S7COMMP_SOFTDATATYPE_BOOL, t.S7COMMP_SOFTDATATYPE_BBOOL)) sk = "Boolean";
  else if (
    is(t.S7COMMP_SOFTDATATYPE_INT, t.S7COMMP_SOFTDATATYPE_DINT, t.S7COMMP_SOFTDATATYPE_ULINT, t.S7COMMP_SOFTDATATYPE_LINT,
      t.S7COMMP_SOFTDATATYPE_USINT, t.S7COMMP_SOFTDATATYPE_UINT, t.S7COMMP_SOFTDATATYPE_UDINT, t.S7COMMP_SOFTDATATYPE_SINT)
  ) sk = "Integer";
  else if (is(t.S7COMMP_SOFTDATATYPE_BYTE, t.S7COMMP_SOFTDATATYPE_WORD, t.S7COMMP_SOFTDATATYPE_DWORD, t.S7COMMP_SOFTDATATYPE_LWORD)) sk = "Binary";
  else if (is(t.S7COMMP_SOFTDATATYPE_REAL, t.S7COMMP_SOFTDATATYPE_LREAL)) sk = "Number";
  else if (is(t.S7COMMP_SOFTDATATYPE_CHAR, t.S7COMMP_SOFTDATATYPE_WCHAR)) sk = "Char";
  else if (is(t.S7COMMP_SOFTDATATYPE_STRING, t.S7COMMP_SOFTDATATYPE_WSTRING)) sk = "Text";
  else if (is(t.S7COMMP_SOFTDATATYPE_DATE)) sk = "Date";
  else if (is(t.S7COMMP_SOFTDATATYPE_TIMEOFDAY, t.S7COMMP_SOFTDATATYPE_LTOD)) sk = "Time";
  else if (is(t.S7COMMP_SOFTDATATYPE_TIME, t.S7COMMP_SOFTDATATYPE_LTIME, t.S7COMMP_SOFTDATATYPE_S5TIME, t.S7COMMP_SOFTDATATYPE_TIMER)) sk = "Timer";
  else if (is(t.S7COMMP_SOFTDATATYPE_DATEANDTIME, t.S7COMMP_SOFTDATATYPE_LDT, t.S7COMMP_SOFTDATATYPE_DTL)) sk = "DateTime";
  else if (is(t.S7COMMP_SOFTDATATYPE_ANY, t.S7COMMP_SOFTDATATYPE_POINTER, t.S7COMMP_SOFTDATATYPE_REMOTE)) sk = "Any";
  if (vte.offsetInfoType.hasRelation()) sk = "Structure";
  return sk;
}

function addNode(parent: Node, text: string, kind: string, tag?: number, withPlaceholder = false): Node {
  const n: Node = { text, parent, kind, tag, children: withPlaceholder ? null : [] };
  parent.children!.push(n);
  return n;
}

/** Port of treeView1_AfterExpand: lazy load of the children of a node. */
async function expand(node: Node): Promise<void> {
  if (node.children !== null) return;
  node.children = [];
  if (!conn || node.tag === undefined || node.tag === 0) return;
  status("loading...");
  const pObj = await conn.getTypeInfoByRelId(node.tag);
  status("connected");
  if (!pObj || !pObj.varnameList || !pObj.vartypeList) return;
  const names = pObj.varnameList.names;
  const els = pObj.vartypeList.elements;
  for (let i = 0; i < names.length; ++i) {
    const oit: any = els[i].offsetInfoType;
    const tn = addNode(node, names[i], imageKey(els[i]));
    if (oit.is1Dim()) {
      const cnt: number = oit.getArrayElementCount();
      const lb: number = oit.getArrayLowerBounds();
      for (let j = 0; j < cnt; ++j) {
        const a = addNode(tn, names[i] + "[" + (j + lb) + "]", imageKey(els[i]));
        if (oit.hasRelation()) {
          a.tag = oit.getRelationId();
          a.children = null;
        }
      }
      tn.tag = 0; // is array
    } else if (oit.isMDim()) {
      const cnts: number[] = oit.getMdimArrayElementCount();
      const lbs: number[] = oit.getMdimArrayLowerBounds();
      const dimCount = cnts.reduce((acc, act) => acc + (act > 0 ? 1 : 0), 0);
      const idx: number[] = new Array(dimCount).fill(0);
      let stop = false;
      while (!stop) {
        let s = "";
        for (let j = dimCount - 1; j >= 0; --j) s += (s !== "" ? "," : "") + (idx[j] + lbs[j]);
        const a = addNode(tn, names[i] + "[" + s + "]", imageKey(els[i]));
        if (oit.hasRelation()) {
          a.tag = oit.getRelationId();
          a.children = null;
        }
        ++idx[0];
        for (let j = 0; j < dimCount; ++j) {
          if (idx[j] >= cnts[j]) {
            if (j + 1 < dimCount) {
              idx[j] = 0;
              ++idx[j + 1];
            } else stop = true;
          } else break;
        }
      }
      tn.tag = 0; // is array
    } else if (oit.hasRelation()) {
      tn.tag = oit.getRelationId();
      tn.children = null;
    }
  }
}

function escapeTiaString(str: string, isRootNode: boolean, isArray: boolean): string {
  if (isRootNode) return '"' + str + '"';
  const re = /(^[0-9]|[^0-9A-Za-z_])/;
  if (isArray) {
    const m = /^([^"]*)(\[[0-9, ]+\])$/.exec(str);
    if (!m) return str;
    if (re.test(m[1])) return '"' + m[1] + '"' + m[2];
    return str;
  }
  if (re.test(str)) return '"' + str + '"';
  return str;
}

/** Port of treeView1_AfterSelect: symbol name of a leaf node (undefined if the node has a relation id). */
function symbolOf(node: Node): string | undefined {
  if (node.tag !== undefined) return undefined; // has relId
  let name = "";
  let tn: Node | null = node;
  while (tn !== null && tn.parent !== null) {
    let isArray = false;
    const nodeText = tn.text;
    tn = tn.parent;
    if (tn !== null && tn.parent !== null && tn.tag === 0) {
      isArray = true;
      tn = tn.parent; // skip array parent
    }
    if (tn !== null && tn.tag !== undefined) {
      // don't add in/out/merker area as tag
      if (tn.tag === 0x90010000 || tn.tag === 0x90020000 || tn.tag === 0x90030000) tn = null;
    }
    if (tn !== null && tn.parent === null) tn = null; // virtual root = no parent in the GUI
    name = escapeTiaString(nodeText, tn === null, isArray) + (name !== "" ? "." : "") + name;
  }
  return name;
}

function pathOf(node: Node): string {
  const l: string[] = [];
  for (let n: Node | null = node; n && n.parent; n = n.parent) l.unshift(n.text);
  return "/" + l.join("/");
}

function findChild(name: string): Node | undefined {
  const c = cwd.children ?? [];
  return c.find((n) => n.text === name) ?? c.find((n) => n.text.toLowerCase() === name.toLowerCase());
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------
function need(): S7CommPlusConnection {
  if (!conn) throw new Error("not connected (use: connect <ip> [password] [user])");
  return conn;
}

function err(res: number): string {
  return "error: " + S7Client.errorText(res) + " (" + res + ")";
}

async function loadRoot(): Promise<boolean> {
  const c = need();
  status("loading...");
  const r = await c.getListOfDatablocks();
  if (r.res !== 0) {
    status(err(r.res));
    return false;
  }
  dbInfos = r.dbInfoList;
  root = { text: "", parent: null, children: [], kind: "" };
  for (const db of dbInfos) addNode(root, db.db_name, "Datablock", db.db_block_ti_relid, true);
  for (const [name, id] of AREAS) addNode(root, name, "Default", id, true);
  cwd = root;
  status("connected");
  return true;
}

async function doConnect(ip: string, password: string, user: string): Promise<void> {
  status("connecting...");
  if (conn) await conn.disconnect();
  conn = new S7CommPlusConnection();
  const res = await conn.connect(ip, password, user);
  if (res !== 0) {
    status(err(res));
    conn = null;
    return;
  }
  status("connected");
  if (!(await loadRoot())) return;
}

async function readTagBySymbol(symbol: string): Promise<PlcTag | null> {
  const c = need();
  status("loading...");
  const tag = await c.getPlcTagBySymbol(symbol);
  status("connected");
  if (tag === null) {
    console.log("symbol not found: " + symbol);
    return null;
  }
  console.log("Symbolic address: " + tag.address.getAccessString());
  const res = await c.readTags([tag]);
  if (res !== 0) {
    console.log(err(res));
    return tag;
  }
  console.log("Value: " + tag.toString());
  return tag;
}

function parseScalar(proto: unknown, s: string): unknown {
  if (typeof proto === "boolean") {
    if (/^(1|true|on)$/i.test(s)) return true;
    if (/^(0|false|off)$/i.test(s)) return false;
    throw new Error("expected boolean (true/false/1/0)");
  }
  if (typeof proto === "bigint") return BigInt(s);
  if (typeof proto === "number") {
    const n = Number(s);
    if (Number.isNaN(n)) throw new Error("expected a number");
    return n;
  }
  if (proto instanceof Date) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error("expected a date/time (ISO 8601)");
    return d;
  }
  return s;
}

function parseValue(tag: any, s: string): unknown {
  const cur = tag.value;
  if (cur instanceof Uint8Array) return Uint8Array.from(s.split(",").map((x) => Number(x.trim())));
  if (Array.isArray(cur)) return s.split(",").map((x) => parseScalar(cur[0], x.trim()));
  if (typeof cur === "string" && tag.value !== undefined && typeof tag.setCharEncoding === "function" && tag.constructor.name.includes("Char")) {
    return s;
  }
  return parseScalar(cur, s);
}

function hex(s: string): number {
  return Number(/^0x/i.test(s) ? s : "0x" + s) >>> 0;
}

const HELP = `Commands (Form1 equivalent in brackets):
  connect <ip> [password] [user]   connect and load the root of the tree      [Connect button]
  disconnect                       close the connection, clear the tree        [Disconnect button]
  status                           show connection state                       [Status label]
  ls [path]                        list children of the current node/path      [TreeView]
  cd <name|..|/|path>              expand / enter a node (lazy loading)        [TreeView expand]
  pwd                              show current tree path
  tree [depth]                     print the loaded tree below the current node
  select <name>                    select a leaf, show its symbol and read it  [TreeView select]
  read <symbol>                    read tag by symbolic name, e.g. "DB1".x.y   [Read button]
  write <symbol> <value>           write a value (arrays: comma separated)
  monitor <cycleMs> <count> <symbol...>  subscribe, print changes, unsubscribe
  comments <db name|db number|0xrelid>   comments XML of a datablock / area
  state <stop|run|n>               set PLC operating state (1=stop, 3=run)
  alarms [langId]                  list active alarms (default 1033)
  alarmdefs [langId]               explore AS / user program alarm definitions
  alarmwatch [count] [timeoutMs] [langId]  subscribe to alarm notifications
  help, quit`;

async function handle(line: string): Promise<boolean> {
  const t = line.match(/(?:"[^"]*"|[^\s"])+/g) ?? [];
  if (t.length === 0) return true;
  const cmd = (t[0] ?? "").toLowerCase();
  const a = t.slice(1);
  // symbols may contain quotes ("DB 1".a), so for symbol commands use the raw remainder
  const rest = (n: number): string => line.trim().split(/\s+/).slice(n).join(" ");
  switch (cmd) {
    case "help":
    case "?":
      console.log(HELP);
      break;
    case "quit":
    case "exit":
      return false;
    case "connect":
      if (a.length < 1) console.log("usage: connect <ip> [password] [user]");
      else await doConnect(a[0], a[1] ?? "", a[2] ?? "");
      break;
    case "disconnect":
      status("disconnecting...");
      if (conn) await conn.disconnect();
      conn = null;
      root = { text: "", parent: null, children: [], kind: "" };
      cwd = root;
      status("disconnected");
      break;
    case "status":
      console.log(conn ? "connected" : "disconnected");
      break;
    case "pwd":
      console.log(pathOf(cwd));
      break;
    case "ls": {
      need();
      let target = cwd;
      if (a[0]) target = resolve(a.join(" "));
      await expand(target);
      for (const n of target.children!) {
        console.log(`${n.tag === undefined ? " " : n.children === null || n.children.length ? "+" : " "} ${n.text}  <${n.kind}>`);
      }
      break;
    }
    case "cd": {
      need();
      const target = resolve(a.join(" ") || "/");
      await expand(target);
      cwd = target;
      console.log(pathOf(cwd));
      break;
    }
    case "tree": {
      need();
      const maxDepth = a[0] ? Number(a[0]) : 2;
      const walk = async (n: Node, d: number): Promise<void> => {
        await expand(n);
        for (const c of n.children!) {
          console.log("  ".repeat(d) + c.text);
          if (d + 1 < maxDepth && c.tag !== undefined) await walk(c, d + 1);
        }
      };
      await walk(cwd, 0);
      break;
    }
    case "select": {
      need();
      const n = findChild(a.join(" "));
      if (!n) {
        console.log("no such node");
        break;
      }
      const sym = symbolOf(n);
      if (sym === undefined) {
        console.log("node has children, use cd");
        break;
      }
      console.log("Symbol: " + sym);
      await readTagBySymbol(sym);
      break;
    }
    case "read":
      need();
      if (!rest(1)) console.log("usage: read <symbol>");
      else await readTagBySymbol(rest(1));
      break;
    case "write": {
      const c = need();
      const m = /^\s*\S+\s+((?:"[^"]*"|[^\s"])+)\s+(.*?)\s*$/.exec(line);
      if (!m) {
        console.log('usage: write <symbol> <value>   (quote parts of the symbol containing spaces, e.g. "DB 1".x)');
        break;
      }
      const sym = m[1];
      const val = m[2].replace(/^"(.*)"$/, "$1");
      const tag: any = await c.getPlcTagBySymbol(sym);
      if (!tag) {
        console.log("symbol not found: " + sym);
        break;
      }
      let res = await c.readTags([tag]); // determine current value type
      if (res !== 0) {
        console.log(err(res));
        break;
      }
      try {
        tag.value = parseValue(tag, val);
      } catch (e: any) {
        console.log("invalid value: " + e.message);
        break;
      }
      res = await c.writeTags([tag]);
      if (res !== 0 || tag.lastWriteError !== 0n) console.log(err(res) + " writeError=" + tag.lastWriteError);
      else console.log("written; read back:");
      await readTagBySymbol(sym);
      break;
    }
    case "monitor": {
      const c = need();
      if (a.length < 3) {
        console.log("usage: monitor <cycleMs> <count> <symbol...>");
        break;
      }
      const tags: PlcTag[] = [];
      for (const s of a.slice(2)) {
        const tg = await c.getPlcTagBySymbol(s);
        if (tg) tags.push(tg);
        else console.log("symbol not found: " + s);
      }
      if (tags.length === 0) break;
      let res = await c.subscriptionCreate(tags, Number(a[0]));
      if (res !== 0) {
        console.log(err(res));
        break;
      }
      res = await c.testWaitForVariableChangeNotifications(Number(a[1]));
      if (res !== 0) console.log(err(res));
      for (const tg of tags) console.log(tg.name + " = " + tg.toString());
      await c.subscriptionDelete();
      break;
    }
    case "comments": {
      const c = need();
      const arg = a.join(" ").replace(/^"(.*)"$/, "$1");
      if (!arg) {
        console.log("usage: comments <db name|db number|0xrelid>");
        break;
      }
      let relid: number;
      const db = dbInfos.find((d) => d.db_name === arg) ?? (/^\d+$/.test(arg) ? dbInfos.find((d) => d.db_number === Number(arg)) : undefined);
      if (db) relid = db.db_block_relid;
      else if (/^0x/i.test(arg)) relid = hex(arg);
      else {
        console.log("unknown datablock: " + arg);
        break;
      }
      const r = await c.getCommentsXml(relid);
      if (r.res !== 0) console.log(err(r.res));
      else console.log("Line comments:\n" + r.xmlLinecomment + "\nDB comments:\n" + r.xmlDbcomment);
      break;
    }
    case "state": {
      const c = need();
      const v = a[0]?.toLowerCase();
      const n = v === "stop" ? 1 : v === "run" ? 3 : Number(v);
      if (!v || Number.isNaN(n)) {
        console.log("usage: state <stop|run|number>");
        break;
      }
      const res = await c.setPlcOperatingState(n);
      console.log(res === 0 ? "operating state " + n + " requested" : err(res));
      break;
    }
    case "alarms": {
      const c = need();
      const r = await c.getActiveAlarms(a[0] ? Number(a[0]) : 1033);
      if (r.res !== 0) console.log(err(r.res));
      else {
        console.log(r.alarmList.length + " active alarm(s)");
        for (const al of r.alarmList) console.log(String(al));
      }
      break;
    }
    case "alarmdefs": {
      const c = need();
      const map = new Map<bigint, AlarmData>();
      const res = await c.exploreASAlarms(map, a[0] ? Number(a[0]) : 1033);
      if (res !== 0) console.log(err(res));
      else for (const [k, v] of map) console.log("Alarm " + k + "\n" + v.toString());
      break;
    }
    case "alarmwatch": {
      const c = need();
      let res = await c.alarmSubscriptionCreate();
      if (res !== 0) {
        console.log(err(res));
        break;
      }
      res = await c.testWaitForAlarmNotifications(a[1] ? Number(a[1]) : 20000, a[0] ? Number(a[0]) : 3, a[2] ? Number(a[2]) : 1033);
      if (res !== 0) console.log(err(res));
      await c.alarmSubscriptionDelete();
      break;
    }
    default:
      console.log("unknown command: " + cmd + " (try help)");
  }
  return true;
}

/** Resolve a path (relative to cwd, or absolute with leading "/") to a node, expanding as needed. */
function resolve(p: string): Node {
  let n = p.startsWith("/") ? root : cwd;
  for (const part of p.split("/").filter((x) => x !== "")) {
    if (part === ".") continue;
    if (part === "..") {
      n = n.parent ?? n;
      continue;
    }
    const prev = cwd;
    cwd = n;
    const c = findChild(part.replace(/^"(.*)"$/, "$1"));
    cwd = prev;
    if (!c) throw new Error("no such node: " + part + " (expand the parent first with cd/ls)");
    n = c;
  }
  return n;
}

async function main(): Promise<void> {
  const [ip, password = "", user = ""] = process.argv.slice(2);
  console.log("S7CommPlus symbol browser. Type 'help' for commands.");
  if (ip) await doConnect(ip, password, user);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "s7> " });
  rl.prompt();
  for await (const line of rl) {
    try {
      if (!(await handle(line))) break;
    } catch (e: any) {
      console.log("ERROR: " + (e?.message ?? e));
    }
    rl.prompt();
  }
  if (conn) await conn.disconnect();
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
