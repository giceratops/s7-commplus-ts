/*
 * In-process mock S7-1500 for integration tests of the network layer.
 *
 * Speaks, on a node:net server socket:
 *   - ISO-on-TCP: COTP connection request / connect confirm (36 bytes, as S7Client.ISOConnect requires), DT TPDUs
 *   - the unencrypted S7+ InitSsl exchange
 *   - a real TLS 1.3 server handshake (node:tls TLSSocket in server mode) tunnelled through DT TPDUs
 *   - S7+ session setup: CreateObject (server session struct), SetMultiVariables, SystemLimits, legitimation
 *     (legacy SHA1/XOR and new AES-256-CBC with the OMS exporter secret), GetMultiVariables, SetMultiVariables,
 *     SetVariable, GetVarSubstreamed, Explore (datablock list, type info container, single type info), DeleteObject,
 *     subscriptions (CreateObject below the second session id + notifications)
 * and validates the client's behaviour (sequence numbers, integrity ids, session id, address sub areas, value
 * types) recording any deviation in `violations`.
 */
import * as net from "node:net";
import * as tls from "node:tls";
import { Duplex } from "node:stream";
import { deflateSync } from "node:zlib";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  ByteStream, Ids, Functioncode, PObject, PValue, ProtocolVersion, S7p,
  ValueStruct, ValueWString, ValueWStringSparseArray, ValueBlobSparseArray, ValueUDInt, ValueDInt, ValueUSIntArray, ValueRID, ValueBlob, ValueUDIntArray, ValueInt,
  LegitimationType, AccessLevel,
} from "../../src/index.js";
import { generateSelfSignedCert } from "./cert.js";
import {
  buildCreateObjectResponse, buildDeleteObjectResponse, buildErrorResponse, buildExploreResponse,
  buildGetMultiVariablesResponse, buildGetVarSubstreamedResponse, buildInitSslResponse, buildNotification,
  buildSetMultiVariablesResponse, buildSetVariableResponse, itemKey, parseRequest, serializeContainer,
  serializeTypeInfoObject,
} from "./messages.js";
import type { ParsedItemAddress, ParsedRequest } from "./messages.js";
import { COTP_CR, COTP_DT, S7pAssembler, TpktParser, ccFrame, dtFrame, parseCr, s7pFragments, s7pSystemEventFrame } from "./wire.js";
import type { S7pPdu, TpktFrame } from "./wire.js";
import { defaultDbs, defaultStructs, defaultValues, hexU } from "./model.js";
import type { DbDef, StructDef } from "./model.js";

export const ERR_ADDRESS = 0x8104n; // address does not exist
export const ERR_TYPE = 0x8302n; // wrong datatype / size on write
export const ERR_NO_ACCESS = 0x8001n; // protection level
export const ERR_LEGITIMATION = 0x80a1; // negative as Int16 => "access denied"

export type RequestAction =
  | undefined
  | { drop: true } // never answer
  | { close: true } // close the TCP connection without answering
  | { raw: Uint8Array } // send these PDU bytes (S7+ PDU data starting with the opcode) instead of the response
  | { error: true }; // answer with an error function code

export interface MockPlcOptions {
  /** PAOM string of the server session struct, drives the legitimation variant the client chooses. */
  firmware: string;
  /** when set, the PLC starts in the protection level HMIAccess and demands this password */
  password: string | null;
  /** user name for the "new" legitimation (empty = legacy payload inside the new login) */
  users: Map<string, string>;
  tagsPerReadRequestMax: number;
  tagsPerWriteRequestMax: number;
  /** data bytes per S7+ fragment of responses (the client sends at most 970 bytes per fragment) */
  maxFragmentData: number;
  /** if > 0: TLS output is cut into DT TPDUs of this payload size (EOT only on the last one) */
  tpduPayloadMax: number;
  /** if > 0: TCP writes are cut into segments of this size with a short pause in between */
  tcpSegmentSize: number;
  /** how responses leave: one TLS record per S7+ fragment / all fragments in one record / each fragment in two records */
  fragmentWrite: "separate" | "coalesced" | "split";
  /** milliseconds to wait before answering a request */
  responseDelay: (req: ParsedRequest) => number;
  /** hook that may swallow/alter the answer of a request */
  onRequest: ((req: ParsedRequest, conn: PlcConnection) => RequestAction) | null;
  /** send the current values right after creating a subscription */
  initialNotification: boolean;
  /** send the CC but with these tweaks */
  cc: "ok" | "none" | "close" | "wrongType" | "wrongSize";
  initSsl: "ok" | "none" | "error" | "errorResponse";
  /** TLS stage: normal / answer the ClientHello with garbage / close the connection when TLS starts */
  tls: "ok" | "garbage" | "close";
}

export function defaultOptions(): MockPlcOptions {
  return {
    firmware: "1;6ES7 511-1AK02-0AB0;V3.1",
    password: null,
    users: new Map(),
    tagsPerReadRequestMax: 20,
    tagsPerWriteRequestMax: 20,
    maxFragmentData: 1000,
    tpduPayloadMax: 0,
    tcpSegmentSize: 0,
    fragmentWrite: "separate",
    responseDelay: () => 0,
    onRequest: null,
    initialNotification: true,
    cc: "ok",
    initSsl: "ok",
    tls: "ok",
  };
}

export interface LegitRecord {
  kind: "legacy" | "new";
  challenge: Uint8Array;
  /** the data blob / response array sent by the client */
  blob: Uint8Array;
  /** exporter secret the server derived from its side of the TLS session (new login only) */
  omsSecret: Uint8Array | null;
  /** AES key used to decrypt (new login only) */
  key: Uint8Array | null;
  /** decoded payload type/user/password (new login only) */
  payloadType: number | null;
  username: string | null;
  password: string | null;
  ok: boolean;
}

interface SubscriptionState {
  objectId: number;
  refs: Map<number, string>; // item reference id -> value key
  creditLimit: number;
  notificationSeq: number;
  alarm: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockPlc {
  readonly opts: MockPlcOptions;
  readonly dbs: DbDef[];
  readonly structs: StructDef[];
  /** PLC memory keyed by access sequence, e.g. "8A0E0001.B" */
  readonly memory: Map<string, PValue>;
  readonly connections = new Set<PlcConnection>();
  readonly requests: ParsedRequest[] = [];
  readonly violations: string[] = [];
  readonly legitimations: LegitRecord[] = [];
  readonly crInfos: Array<{ localTsap: number; remoteTsap: string }> = [];
  readonly tlsErrors: Error[] = [];
  readonly writes: Array<{ key: string; value: PValue }> = [];
  /** negotiated TLS parameters of every TLS session */
  readonly tlsInfo: Array<{ protocol: string | null; cipher: string }> = [];
  /** number of S7+ fragments the client sent per request PDU */
  readonly requestFragments: number[] = [];
  /** number of S7+ fragments sent in response PDUs */
  readonly responseFragments: number[] = [];
  operatingState: number | null = null;
  maxOutstanding = 0;
  /** exporter secret of the most recent TLS session (server side) */
  lastOmsSecret: Uint8Array | null = null;
  private server: net.Server | null = null;
  private secureContext!: tls.SecureContext;
  port = 0;
  private nextSession = 0x00007a00;

  constructor(options: Partial<MockPlcOptions> = {}) {
    this.opts = { ...defaultOptions(), ...options };
    this.dbs = defaultDbs();
    this.structs = defaultStructs();
    this.memory = defaultValues();
    // SystemLimits (read by CommRessources.ReadMax): ObjectRoot / SystemLimits / LID
    const lim = (lid: number, v: number): void => void this.memory.set(`${hexU(Ids.ObjectRoot)}.${hexU(lid)}`, new ValueDInt(v));
    lim(1000, this.opts.tagsPerReadRequestMax);
    lim(1001, this.opts.tagsPerWriteRequestMax);
    lim(0, 32); // subscriptions
    lim(1, 10000); // attributes
    lim(2, 65536); // subscription memory
  }

  async start(): Promise<number> {
    const { key, cert } = generateSelfSignedCert();
    this.secureContext = tls.createSecureContext({ key, cert, minVersion: "TLSv1.3" });
    this.server = net.createServer((socket) => {
      const c = new PlcConnection(this, socket);
      this.connections.add(c);
      socket.on("close", () => this.connections.delete(c));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of [...this.connections]) c.destroy();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Port that nobody listens on any more (for "connection refused"). */
  static async unusedPort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  }

  get tlsContext(): tls.SecureContext {
    return this.secureContext;
  }

  nextSessionId(): number {
    const id = this.nextSession;
    this.nextSession += 4;
    return id;
  }

  violation(msg: string): void {
    this.violations.push(msg);
  }

  /** Changes a value in the PLC memory and sends a change notification to subscribers. */
  setValue(key: string, value: PValue): void {
    this.memory.set(key, value);
    for (const c of this.connections) c.notifyChange(key);
  }

  /** Sends a SystemEvent PDU (protocol 0xFE, text message) to all clients. */
  async sendSystemEventMessage(text: string): Promise<void> {
    const data = new ByteStream();
    for (let i = 0; i < 4; i++) S7p.encodeUInt32(data, i === 1 ? 0 : 0);
    data.write(new TextEncoder().encode(text));
    for (const c of this.connections) await c.writeApp(s7pSystemEventFrame(data.toArray()));
  }

  allKeysOfType(): string[] {
    return [...this.memory.keys()];
  }
}

export class PlcConnection {
  private readonly tpkt = new TpktParser();
  private readonly plainAsm = new S7pAssembler();
  private readonly appAsm = new S7pAssembler();
  private stage: "cotp" | "plain" | "tls" = "cotp";
  private duplex: Duplex | null = null;
  private tlsSock: tls.TLSSocket | null = null;
  private outChain: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();
  private lastSeq = 0;
  private integrity = { normal: 0, set: 0 };
  private sessionId = 0;
  private sessionId2 = 0;
  private sessionDeleted = false;
  private authed = false;
  private omsKey: Buffer | null = null;
  private challenge: Buffer | null = null;
  private outstanding = 0;
  private subs = new Map<number, SubscriptionState>();
  private nextSubId = 0;
  private closed = false;
  private garbageTls = false;

  constructor(private readonly plc: MockPlc, private readonly socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on("data", (d) => {
      try {
        for (const f of this.tpkt.push(d)) this.onFrame(f);
      } catch (e) {
        plc.violation("transport: " + (e as Error).message);
        this.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.closed = true;
      this.tlsSock?.destroy();
      this.duplex?.destroy();
    });
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ----------------------------------------------------------------------------------------------------------
  // Transport
  // ----------------------------------------------------------------------------------------------------------

  private onFrame(f: TpktFrame): void {
    if (f.cotpType === COTP_CR) {
      const cr = parseCr(f);
      this.plc.crInfos.push({ localTsap: cr.localTsap, remoteTsap: cr.remoteTsap });
      this.stage = "plain";
      const opt = this.plc.opts;
      if (opt.cc === "none") return;
      if (opt.cc === "close") {
        this.destroy();
        return;
      }
      let cc = ccFrame(cr.srcRef, new TextEncoder().encode(cr.remoteTsap.padEnd(16, " ")));
      if (opt.cc === "wrongType") cc[5] = 0x80; // DR (disconnect request) instead of CC
      if (opt.cc === "wrongSize") cc = cc.subarray(0, 33).slice(), (cc[3] = 33), (cc[4] = 28);
      void this.rawWrite(cc);
      return;
    }
    if (f.cotpType !== COTP_DT) {
      this.plc.violation("unexpected COTP type 0x" + f.cotpType.toString(16));
      return;
    }
    if (this.stage === "plain") {
      for (const pdu of this.plainAsm.push(f.payload)) this.onPlainPdu(pdu);
    } else if (this.stage === "tls") {
      if (this.garbageTls) {
        // answer the ClientHello with something that is no TLS record
        this.garbageTls = false;
        void this.rawWrite(dtFrame(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\n\r\n")));
        return;
      }
      this.duplex?.push(Buffer.from(f.payload));
    } else {
      this.plc.violation("DT before CR");
    }
  }

  private onPlainPdu(pdu: S7pPdu): void {
    const req = parseRequest(pdu.version, pdu.data, false);
    this.plc.requests.push(req);
    if (req.kind !== "InitSsl") {
      this.plc.violation("unencrypted request other than InitSsl: " + req.kind);
      return;
    }
    if (req.version !== ProtocolVersion.V1) this.plc.violation("InitSsl protocol version " + req.version);
    if (req.sequenceNumber !== 1) this.plc.violation("InitSsl sequence number " + req.sequenceNumber);
    this.lastSeq = req.sequenceNumber;
    // From now on everything is TLS: install the TLS server before the ClientHello can arrive.
    this.stage = "tls";
    if (this.plc.opts.tls === "close") {
      void this.rawWrite(this.plainFragmentFrames(req.version, buildInitSslResponse(req.sequenceNumber, 0n))).then(() => this.destroy());
      return;
    }
    this.startTls();
    if (this.plc.opts.initSsl === "none") return;
    const ret = this.plc.opts.initSsl === "error" ? 0x8000000000000001n : 0n;
    const body =
      this.plc.opts.initSsl === "errorResponse" ? buildErrorResponse(req.sequenceNumber) : buildInitSslResponse(req.sequenceNumber, ret);
    void this.rawWrite(this.plainFragmentFrames(req.version, body));
  }

  private plainFragmentFrames(version: number, body: Uint8Array): Uint8Array {
    const frags = s7pFragments(version, body, 0xffff);
    return dtFrame(Buffer.concat(frags));
  }

  private startTls(): void {
    if (this.plc.opts.tls === "garbage") {
      this.garbageTls = true;
      return;
    }
    this.duplex = new Duplex({
      write: (chunk: Buffer, _enc, cb) => {
        this.transportWrite(chunk).then(() => cb(), (e) => cb(e));
      },
      read() {
        /* fed from onFrame */
      },
    });
    this.tlsSock = new tls.TLSSocket(this.duplex, { isServer: true, secureContext: this.plc.tlsContext });
    this.tlsSock.on("error", (e) => {
      this.plc.tlsErrors.push(e);
    });
    this.tlsSock.on("data", (d: Buffer) => this.onAppData(d));
    this.tlsSock.on("secure", () => {
      this.plc.tlsInfo.push({ protocol: this.tlsSock!.getProtocol(), cipher: this.tlsSock!.getCipher().name });
    });
    this.tlsSock.on("close", () => this.destroy());
  }

  /** Writes TLS output to the socket as one or more DT TPDUs. */
  private async transportWrite(chunk: Uint8Array): Promise<void> {
    const max = this.plc.opts.tpduPayloadMax;
    if (max > 0 && chunk.length > max) {
      for (let p = 0; p < chunk.length; p += max) {
        const part = chunk.subarray(p, Math.min(chunk.length, p + max));
        await this.rawWrite(dtFrame(part, p + max >= chunk.length));
      }
    } else {
      await this.rawWrite(dtFrame(chunk));
    }
  }

  /** Serialised raw TCP writes, optionally cut into small segments. */
  private rawWrite(data: Uint8Array): Promise<void> {
    const seg = this.plc.opts.tcpSegmentSize;
    const job = async (): Promise<void> => {
      if (this.closed) return;
      if (seg > 0 && data.length > seg) {
        for (let p = 0; p < data.length; p += seg) {
          if (this.closed) return;
          await new Promise<void>((resolve) => this.socket.write(data.subarray(p, p + seg), () => resolve()));
          await sleep(2);
        }
      } else {
        await new Promise<void>((resolve) => this.socket.write(data, () => resolve()));
      }
    };
    this.outChain = this.outChain.then(job, job);
    return this.outChain;
  }

  /** Writes application data into the TLS session. */
  writeApp(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.tlsSock || this.tlsSock.destroyed) return resolve();
      this.tlsSock.write(data, () => resolve());
    });
  }

  private async sendPdu(version: number, body: Uint8Array): Promise<void> {
    const frags = s7pFragments(version, body, this.plc.opts.maxFragmentData);
    this.plc.responseFragments.push(frags.length);
    switch (this.plc.opts.fragmentWrite) {
      case "coalesced":
        await this.writeApp(Buffer.concat(frags));
        break;
      case "split":
        for (const f of frags) {
          const half = Math.max(1, f.length >> 1);
          await this.writeApp(f.subarray(0, half));
          await this.writeApp(f.subarray(half));
        }
        break;
      default:
        for (const f of frags) await this.writeApp(f);
    }
  }

  // ----------------------------------------------------------------------------------------------------------
  // Request handling
  // ----------------------------------------------------------------------------------------------------------

  private onAppData(d: Buffer): void {
    let pdus: S7pPdu[];
    try {
      pdus = this.appAsm.push(d);
    } catch (e) {
      this.plc.violation("S7+ framing: " + (e as Error).message);
      return;
    }
    for (const pdu of pdus) {
      let req: ParsedRequest;
      try {
        req = parseRequest(pdu.version, pdu.data, this.sessionId !== 0);
      } catch (e) {
        this.plc.violation("request parse: " + (e as Error).message);
        continue;
      }
      this.plc.requests.push(req);
      this.plc.requestFragments.push(pdu.fragments);
      const expectsResponse = !(req.kind === "SetVariable" && req.transportFlags === 0x74);
      if (expectsResponse) {
        this.outstanding++;
        this.plc.maxOutstanding = Math.max(this.plc.maxOutstanding, this.outstanding);
      }
      this.work = this.work.then(() => this.handle(req, expectsResponse, pdu.fragments)).catch((e) => {
        this.plc.violation("handler error: " + (e as Error).stack);
      });
    }
  }

  private checkHeader(req: ParsedRequest): void {
    const exp = this.lastSeq === 0xffff ? 1 : this.lastSeq + 1;
    if (req.sequenceNumber !== exp) this.plc.violation(`sequence number ${req.sequenceNumber}, expected ${exp} (${req.kind})`);
    this.lastSeq = req.sequenceNumber;
    if (this.sessionId !== 0 && req.sessionId !== this.sessionId) {
      this.plc.violation(`session id 0x${req.sessionId.toString(16)}, expected 0x${this.sessionId.toString(16)} (${req.kind})`);
    }
    if (this.sessionId === 0 && req.sessionId !== Ids.ObjectNullServerSession) {
      this.plc.violation(`first request session id ${req.sessionId} != ObjectNullServerSession`);
    }
    if (req.integrityId !== null) {
      const set =
        req.functionCode === Functioncode.SetMultiVariables || req.functionCode === Functioncode.SetVariable ||
        req.functionCode === Functioncode.SetVarSubStreamed || req.functionCode === Functioncode.DeleteObject ||
        req.functionCode === Functioncode.CreateObject;
      const cls = set ? "set" : "normal";
      const exp2 = (this.integrity[cls] + 1) >>> 0;
      if (req.integrityId !== exp2) this.plc.violation(`integrity id (${cls}) ${req.integrityId}, expected ${exp2} (${req.kind})`);
      this.integrity[cls] = req.integrityId;
    }
  }

  private async handle(req: ParsedRequest, expectsResponse: boolean, fragments: number): Promise<void> {
    try {
      this.checkHeader(req);
      const act = this.plc.opts.onRequest?.(req, this);
      if (act && "close" in act) {
        this.destroy();
        return;
      }
      if (act && "drop" in act) return;
      const delay = this.plc.opts.responseDelay(req);
      if (delay > 0) await sleep(delay);
      let body: Uint8Array | null;
      if (act && "raw" in act) body = act.raw;
      else if (act && "error" in act) body = buildErrorResponse(req.sequenceNumber);
      else body = this.respond(req, fragments);
      if (body !== null) await this.sendPdu(req.version, body);
    } finally {
      if (expectsResponse) this.outstanding--;
    }
  }

  private respondInteg(req: ParsedRequest): number {
    return (req.sequenceNumber + (req.integrityId ?? 0)) >>> 0;
  }

  private respond(req: ParsedRequest, _fragments: number): Uint8Array | null {
    switch (req.kind) {
      case "CreateObject":
        return this.onCreateObject(req);
      case "SetMultiVariables":
        return this.onSetMulti(req);
      case "GetMultiVariables":
        return this.onGetMulti(req);
      case "SetVariable":
        return this.onSetVariable(req);
      case "GetVarSubstreamed":
        return this.onGetVarSubstreamed(req);
      case "DeleteObject":
        return this.onDeleteObject(req);
      case "Explore":
        return this.onExplore(req);
      default:
        this.plc.violation("unhandled request " + req.kind + " fn=0x" + req.functionCode.toString(16));
        return buildErrorResponse(req.sequenceNumber);
    }
  }

  // ---- CreateObject -------------------------------------------------------------------------------------------

  private onCreateObject(req: Extract<ParsedRequest, { kind: "CreateObject" }>): Uint8Array {
    const obj = req.object;
    if (req.requestId === Ids.ObjectServerSessionContainer && obj.classId === Ids.ClassServerSession) {
      if (req.version !== ProtocolVersion.V1) this.plc.violation("session CreateObject protocol version " + req.version);
      if (req.integrityId !== null) this.plc.violation("first CreateObject must not carry an IntegrityId");
      this.sessionId = this.plc.nextSessionId();
      this.sessionId2 = this.sessionId + 1;
      const resp = new PObject(this.sessionId, Ids.ClassServerSession, 0);
      const st = new ValueStruct(Ids.ServerSessionVersion);
      st.addStructElement(Ids.LID_SessionVersionSystemPAOMString, new ValueWString(this.plc.opts.firmware));
      resp.addAttribute(Ids.ServerSessionVersion, st);
      return buildCreateObjectResponse(req.sequenceNumber, 0n, [this.sessionId, this.sessionId2], resp);
    }
    if (obj.classId === Ids.ClassSubscription) {
      if (req.requestId !== this.sessionId2) this.plc.violation("subscription created below 0x" + req.requestId.toString(16));
      const sub: SubscriptionState = {
        objectId: 0x7fffc100 + ++this.nextSubId,
        refs: new Map(),
        creditLimit: 0,
        notificationSeq: 0,
        alarm: false,
      };
      const fc = obj.attributes.get(Ids.SubscriptionFunctionClassId) as { getValue(): number } | undefined;
      sub.alarm = fc?.getValue() === 2;
      const cl = obj.attributes.get(Ids.SubscriptionCreditLimit) as ValueInt | undefined;
      sub.creditLimit = cl ? cl.getValue() : 0;
      const refList = obj.attributes.get(Ids.SubscriptionReferenceList) as ValueUDIntArray | undefined;
      if (refList && !sub.alarm) this.parseReferenceList(refList.getValue(), sub);
      this.subs.set(sub.objectId, sub);
      const resp = new PObject(0, Ids.ClassSubscription, 0);
      const body = buildCreateObjectResponse(req.sequenceNumber, 0n, [sub.objectId], resp);
      if (this.plc.opts.initialNotification && !sub.alarm) {
        // The PLC sends all values with the first notification, right behind the CreateObject response.
        setTimeout(() => this.sendNotification(sub, [...sub.refs.keys()]), 5);
      }
      return body;
    }
    this.plc.violation("unexpected CreateObject class " + obj.classId);
    return buildCreateObjectResponse(req.sequenceNumber, 0x8104n, [], new PObject(0, 0, 0));
  }

  /** Reference list layout: Subscription.cs getSubscriptionListArray */
  private parseReferenceList(la: number[], sub: SubscriptionState): void {
    let p = 0;
    p++; // 0x8?ssxxxx
    const unsub = la[p++];
    const count = la[p++];
    if (unsub !== 0) this.plc.violation("unsubscribe count " + unsub);
    for (let i = 0; i < count; i++) {
      const head = la[p++];
      const refId = la[p++];
      p++; // unknown 1
      const area = la[p++];
      p++; // symbol crc
      const n = (head & 0xffff) - 1; // fields after the sub area
      p++; // sub area
      const lids: number[] = [];
      for (let k = 0; k < n; k++) lids.push(la[p++]);
      sub.refs.set(refId, itemKey({ symbolCrc: 0, accessArea: area, accessSubArea: 0, lid: lids }));
    }
  }

  notifyChange(key: string): void {
    for (const sub of this.subs.values()) {
      const refs = [...sub.refs].filter(([, k]) => k === key).map(([r]) => r);
      if (refs.length > 0) void this.sendNotification(sub, refs);
    }
  }

  async sendNotification(sub: SubscriptionState, refs: number[]): Promise<void> {
    if (this.closed) return;
    const values = new Map<number, PValue>();
    for (const r of refs) {
      const v = this.plc.memory.get(sub.refs.get(r)!);
      if (v) values.set(r, v);
    }
    const body = buildNotification({
      subscriptionObjectId: sub.objectId,
      creditTick: sub.notificationSeq % 256,
      sequenceNumber: sub.notificationSeq++,
      timestampMicros: BigInt(Date.now()) * 1000n,
      values,
    });
    await this.sendPdu(ProtocolVersion.V2, body);
  }

  /** Sends a notification carrying an arbitrary payload for the given subscription. */
  async sendRawNotification(body: Uint8Array): Promise<void> {
    await this.sendPdu(ProtocolVersion.V2, body);
  }

  get subscriptionIds(): number[] {
    return [...this.subs.keys()];
  }

  subscription(id: number): SubscriptionState | undefined {
    return this.subs.get(id);
  }

  // ---- (Set/Get)MultiVariables --------------------------------------------------------------------------------

  private checkAddress(a: ParsedItemAddress): void {
    if (a.accessArea >= 0x8a0e0000) {
      if (a.accessSubArea !== Ids.DB_ValueActual) this.plc.violation(`DB access with sub area ${a.accessSubArea}`);
    }
  }

  private isProtected(a: ParsedItemAddress): boolean {
    return this.plc.opts.password !== null && !this.authed && a.accessArea !== Ids.ObjectRoot;
  }

  private dbRidKey(a: ParsedItemAddress): DbDef | undefined {
    if (a.lid.length === 1 && a.lid[0] === 1 && a.accessSubArea === Ids.DB_ValueActual) {
      return this.plc.dbs.find((d) => d.relId === a.accessArea);
    }
    return undefined;
  }

  private onGetMulti(req: Extract<ParsedRequest, { kind: "GetMultiVariables" }>): Uint8Array {
    if (req.linkId !== 0) this.plc.violation("GetMultiVariables linkId " + req.linkId);
    const values = new Map<number, PValue>();
    const errors = new Map<number, bigint>();
    // (the SystemLimits themselves are read with the default limit of 20 before the PLC's values are known)
    const isLimitsRead = req.addresses.every((a) => a.accessArea === Ids.ObjectRoot);
    if (!isLimitsRead && req.addresses.length > this.plc.opts.tagsPerReadRequestMax) {
      this.plc.violation(`read request with ${req.addresses.length} tags, limit ${this.plc.opts.tagsPerReadRequestMax}`);
    }
    req.addresses.forEach((a, i) => {
      const item = i + 1;
      this.checkAddress(a);
      if (this.isProtected(a)) {
        errors.set(item, ERR_NO_ACCESS);
        return;
      }
      const db = this.dbRidKey(a);
      if (db) {
        if (db.tiRelId === 0) errors.set(item, ERR_ADDRESS);
        else values.set(item, new ValueRID(db.tiRelId));
        return;
      }
      const v = this.plc.memory.get(itemKey(a));
      if (v) values.set(item, v);
      else errors.set(item, ERR_ADDRESS);
    });
    return buildGetMultiVariablesResponse(req.sequenceNumber, this.respondInteg(req), errors.size > 0 ? ERR_ADDRESS : 0n, values, errors);
  }

  private onSetMulti(req: Extract<ParsedRequest, { kind: "SetMultiVariables" }>): Uint8Array {
    const errors = new Map<number, bigint>();
    if (req.inObjectId > 0) {
      // session setup: echoes the ServerSessionVersion struct back
      if (req.inObjectId !== this.sessionId) this.plc.violation("session setup InObjectId " + req.inObjectId);
      if (req.version !== ProtocolVersion.V2) this.plc.violation("session setup protocol version " + req.version);
      if (req.addressIds[0] !== Ids.ServerSessionVersion) this.plc.violation("session setup address " + req.addressIds[0]);
      const st = req.values[0]?.value;
      if (!(st instanceof ValueStruct)) {
        this.plc.violation("session setup value is not a struct");
      } else if ((st.getStructElement(Ids.LID_SessionVersionSystemPAOMString) as ValueWString).getValue() !== this.plc.opts.firmware) {
        this.plc.violation("session setup struct differs");
      }
      return buildSetMultiVariablesResponse(req.sequenceNumber, this.respondInteg(req), 0n, errors);
    }
    if (req.addresses.length > this.plc.opts.tagsPerWriteRequestMax) {
      this.plc.violation(`write request with ${req.addresses.length} tags, limit ${this.plc.opts.tagsPerWriteRequestMax}`);
    }
    req.addresses.forEach((a, i) => {
      const item = req.values[i].item;
      if (item !== i + 1) this.plc.violation(`write item number ${item}, expected ${i + 1}`);
      this.checkAddress(a);
      const key = itemKey(a);
      const cur = this.plc.memory.get(key);
      const nv = req.values[i].value;
      if (this.isProtected(a)) errors.set(item, ERR_NO_ACCESS);
      else if (!cur || !nv) errors.set(item, ERR_ADDRESS);
      else if (cur.constructor !== nv.constructor || this.sizeOf(cur) !== this.sizeOf(nv)) errors.set(item, ERR_TYPE);
      else {
        this.plc.writes.push({ key, value: nv });
        this.plc.setValue(key, nv);
      }
    });
    return buildSetMultiVariablesResponse(req.sequenceNumber, this.respondInteg(req), errors.size > 0 ? ERR_ADDRESS : 0n, errors);
  }

  private sizeOf(v: PValue): number {
    const b = new ByteStream();
    v.serialize(b);
    // arrays: same element count => same type & length class; scalars of VLQ types may differ in encoded size
    const g = v as unknown as { getValue?: () => unknown };
    const x = g.getValue?.();
    return Array.isArray(x) || x instanceof Uint8Array ? (x as ArrayLike<unknown>).length : 0;
  }

  // ---- SetVariable / GetVarSubstreamed / legitimation ----------------------------------------------------------

  private onSetVariable(req: Extract<ParsedRequest, { kind: "SetVariable" }>): Uint8Array | null {
    const v = req.value;
    if (req.inObjectId !== this.sessionId && req.inObjectId !== Ids.NativeObjects_theCPUexecUnit_Rid && !this.isSubscription(req.inObjectId)) {
      this.plc.violation("SetVariable InObjectId 0x" + req.inObjectId.toString(16));
    }
    if (req.address === Ids.Legitimate && v instanceof ValueBlob) return this.legitimateNew(req, v);
    if (req.address === Ids.ServerSessionResponse && v instanceof ValueUSIntArray) return this.legitimateLegacy(req, v);
    if (req.address === Ids.CPUexecUnit_operatingStateReq && v instanceof ValueDInt) {
      this.plc.operatingState = v.getValue();
      return buildSetVariableResponse(req.sequenceNumber, this.respondInteg(req), 0n);
    }
    if (req.address === Ids.SubscriptionCreditLimit && v instanceof ValueInt) {
      const sub = this.subs.get(req.inObjectId);
      if (sub) sub.creditLimit = v.getValue();
      if (req.transportFlags !== 0x74) this.plc.violation("credit limit without no-response flag");
      return null; // no response expected (transport flags 0x74)
    }
    this.plc.violation("unhandled SetVariable address " + req.address);
    return buildSetVariableResponse(req.sequenceNumber, this.respondInteg(req), 0x8104n);
  }

  private isSubscription(id: number): boolean {
    return this.subs.has(id);
  }

  private onGetVarSubstreamed(req: Extract<ParsedRequest, { kind: "GetVarSubstreamed" }>): Uint8Array {
    if (req.inObjectId !== this.sessionId) this.plc.violation("GetVarSubstreamed InObjectId 0x" + req.inObjectId.toString(16));
    if (req.address === Ids.EffectiveProtectionLevel) {
      const level = this.plc.opts.password !== null && !this.authed ? AccessLevel.HMIAccess : AccessLevel.FullAccess;
      return buildGetVarSubstreamedResponse(req.sequenceNumber, this.respondInteg(req), 0n, new ValueUDInt(level));
    }
    if (req.address === Ids.ServerSessionRequest) {
      // legacy login: the answer is SHA1(password) xor challenge => 20 bytes; the new login uses the first 16 as IV
      const len = this.legacyFirmware() ? 20 : 32;
      this.challenge = randomBytes(len);
      return buildGetVarSubstreamedResponse(req.sequenceNumber, this.respondInteg(req), 0n, new ValueUSIntArray(new Uint8Array(this.challenge)));
    }
    this.plc.violation("unhandled GetVarSubstreamed address " + req.address);
    return buildErrorResponse(req.sequenceNumber, Functioncode.GetVarSubStreamed);
  }

  private legacyFirmware(): boolean {
    const m = /^[^;]*;[^;]*[17]\s?(\d{3}).*;[VS](\d{1,2})\.(\d+)$/i.exec(this.plc.opts.firmware);
    if (!m) return false;
    const dev = m[1];
    const fw = parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
    if (dev.startsWith("5")) return fw < 301;
    if (this.plc.opts.firmware.includes("50-0XB0") && dev.startsWith("2")) return false;
    if (dev.startsWith("2")) return fw < 407;
    return dev.startsWith("6");
  }

  private legitimateLegacy(req: Extract<ParsedRequest, { kind: "SetVariable" }>, v: ValueUSIntArray): Uint8Array {
    const resp = Buffer.from(v.getValue());
    const ch = this.challenge ?? Buffer.alloc(0);
    const pw = this.plc.opts.password ?? "";
    const expected = Buffer.from(createHash("sha1").update(pw, "utf8").digest().map((b, i) => b ^ ch[i]));
    const ok = resp.equals(expected);
    this.plc.legitimations.push({
      kind: "legacy", challenge: new Uint8Array(ch), blob: new Uint8Array(resp), omsSecret: null, key: null,
      payloadType: null, username: null, password: null, ok,
    });
    if (ok) this.authed = true;
    return buildSetVariableResponse(req.sequenceNumber, this.respondInteg(req), ok ? 0n : BigInt(ERR_LEGITIMATION));
  }

  private legitimateNew(req: Extract<ParsedRequest, { kind: "SetVariable" }>, v: ValueBlob): Uint8Array {
    const blob = Buffer.from(v.getValue() ?? new Uint8Array(0));
    const ch = this.challenge ?? Buffer.alloc(32);
    if (this.omsKey === null) {
      const oms = Buffer.from(this.tlsSock!.exportKeyingMaterial(32, "EXPERIMENTAL_OMS", undefined as unknown as Buffer));
      this.plc.lastOmsSecret = new Uint8Array(oms);
      this.omsKey = oms;
    }
    // roll the key: key = SHA256(previous secret)
    this.omsKey = createHash("sha256").update(this.omsKey).digest();
    const key = this.omsKey;
    const rec: LegitRecord = {
      kind: "new", challenge: new Uint8Array(ch), blob: new Uint8Array(blob), omsSecret: this.plc.lastOmsSecret,
      key: new Uint8Array(key), payloadType: null, username: null, password: null, ok: false,
    };
    this.plc.legitimations.push(rec);
    try {
      const dec = createDecipheriv("aes-256-cbc", key, ch.subarray(0, 16));
      const plain = Buffer.concat([dec.update(blob), dec.final()]);
      const st = PValue.deserialize(new ByteStream(new Uint8Array(plain)));
      if (!(st instanceof ValueStruct) || st.getValue() !== Ids.LID_LegitimationPayloadStruct) throw new Error("payload is not the legitimation struct");
      const type = (st.getStructElement(Ids.LID_LegitimationPayloadType) as ValueUDInt).getValue();
      const user = Buffer.from((st.getStructElement(Ids.LID_LegitimationPayloadUsername) as ValueBlob).getValue() ?? []).toString("utf8");
      const pwBytes = Buffer.from((st.getStructElement(Ids.LID_LegitimationPayloadPassword) as ValueBlob).getValue() ?? []);
      rec.payloadType = type;
      rec.username = user;
      const pw = this.plc.opts.password ?? "";
      if (type === LegitimationType.New) {
        rec.password = pwBytes.toString("utf8");
        const expectedPw = this.plc.opts.users.get(user);
        rec.ok = expectedPw !== undefined && expectedPw === rec.password;
      } else if (type === LegitimationType.Legacy) {
        rec.password = pwBytes.toString("hex");
        rec.ok = user === "" && pwBytes.equals(createHash("sha1").update(pw, "utf8").digest());
      }
    } catch (e) {
      rec.ok = false;
      this.plc.violation("legitimation decrypt: " + (e as Error).message);
    }
    if (rec.ok) this.authed = true;
    return buildSetVariableResponse(req.sequenceNumber, this.respondInteg(req), rec.ok ? 0n : BigInt(ERR_LEGITIMATION));
  }

  // ---- DeleteObject -------------------------------------------------------------------------------------------

  private onDeleteObject(req: Extract<ParsedRequest, { kind: "DeleteObject" }>): Uint8Array {
    if (req.objectId === this.sessionId) {
      this.sessionDeleted = true;
      // Deleting the own session: the response carries no IntegrityId
      return buildDeleteObjectResponse(req.sequenceNumber, null, 0n, req.objectId);
    }
    if (req.objectId === this.sessionId2) {
      this.subs.clear();
      return buildDeleteObjectResponse(req.sequenceNumber, this.respondInteg(req), 0n, req.objectId);
    }
    if (this.subs.delete(req.objectId)) {
      return buildDeleteObjectResponse(req.sequenceNumber, this.respondInteg(req), 0n, req.objectId);
    }
    return buildDeleteObjectResponse(req.sequenceNumber, this.respondInteg(req), 0x8104n, req.objectId);
  }

  get deleted(): boolean {
    return this.sessionDeleted;
  }

  // ---- Explore ------------------------------------------------------------------------------------------------

  private dbObject(d: DbDef): PObject {
    const o = new PObject(d.relId, Ids.DB_Class_Rid, 0);
    o.addAttribute(Ids.ObjectVariableTypeName, new ValueWString(d.name));
    return o;
  }

  private onExplore(req: Extract<ParsedRequest, { kind: "Explore" }>): Uint8Array {
    const integ = this.respondInteg(req);
    const objs: Uint8Array[] = [];
    const ser = (o: PObject): Uint8Array => {
      const b = new ByteStream();
      o.serialize(b);
      return b.toArray();
    };
    let ret = 0n;
    if (req.exploreId === Ids.NativeObjects_thePLCProgram_Rid) {
      if (req.filter) {
        // datablock list filtered by class (Filter struct, InstanceIOf DB_Class_Rid)
        const f = req.filter as ValueStruct;
        const cls = (f.getStructElement(Ids.FilterValue) as ValueRID).getValue();
        if (cls !== Ids.DB_Class_Rid) this.plc.violation("explore filter class " + cls);
        for (const d of this.plc.dbs) objs.push(ser(this.dbObject(d)));
      } else {
        const prog = new PObject(Ids.NativeObjects_thePLCProgram_Rid, Ids.PLCProgram_Class_Rid, 0);
        for (const d of this.plc.dbs) prog.addObject(this.dbObject(d));
        // a data block in another area and a non-DB object must be ignored by the client
        const odd = new PObject(0x8a0f0001, Ids.DB_Class_Rid, 0);
        odd.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("NotInDbArea"));
        prog.addObject(odd);
        const fc = new PObject(0x00010001, 0x9999, 0);
        fc.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("Main"));
        prog.addObject(fc);
        objs.push(ser(prog));
      }
    } else if (req.exploreId === Ids.ObjectOMSTypeInfoContainer) {
      const children: Uint8Array[] = [];
      for (const d of this.plc.dbs) if (d.tiRelId !== 0) children.push(this.typeInfoObject(d.tiRelId, d.vars));
      for (const s of this.plc.structs) children.push(this.typeInfoObject(s.tiRelId, s.vars, s.size));
      objs.push(serializeContainer(Ids.ObjectOMSTypeInfoContainer, Ids.ClassOMSTypeInfoContainer, children));
    } else if ([0x90010000, 0x90020000, 0x90030000, 0x90050000, 0x90060000].includes(req.exploreId)) {
      // I/Q/M/T/C areas: type info without variables
      objs.push(serializeTypeInfoObject(req.exploreId, 0x0abc, []));
    } else if (this.plc.dbs.some((d) => d.relId === req.exploreId) && req.attributes.includes(Ids.ASObjectES_Comment)) {
      // comments of a datablock (getCommentsXml): DB comment as WString sparse array, line comments as a zlib compressed
      // XML blob with a 4 byte prefix (BlobDecompressor offset 4)
      const o = new PObject(req.exploreId, Ids.DB_Class_Rid, 0);
      o.addAttribute(Ids.ASObjectES_Comment, new ValueWStringSparseArray(new Map([[1032, "DB Kommentar"], [1034, "DB comment"]])));
      const xml = Buffer.from("<InterfaceLineComments><Part Kind=\"Comments\"><Comment Path=\"A\"><DictEntry Language=\"de-DE\">Zaehler</DictEntry></Comment></Part></InterfaceLineComments>");
      const blob = Buffer.concat([Buffer.from([0, 0, 0, 1]), deflateSync(xml)]);
      o.addAttribute(Ids.DataInterface_LineComments, new ValueBlobSparseArray(new Map([[1, { blobRootId: 0, value: new Uint8Array(blob) }]])));
      objs.push(ser(o));
    } else {
      const db = this.plc.dbs.find((d) => d.tiRelId === req.exploreId);
      const st = this.plc.structs.find((s) => s.tiRelId === req.exploreId);
      if (db) objs.push(this.typeInfoObject(db.tiRelId, db.vars));
      else if (st) objs.push(this.typeInfoObject(st.tiRelId, st.vars, st.size));
      else ret = 0x8104n;
    }
    return buildExploreResponse(req.sequenceNumber, integ, ret, req.exploreId, objs);
  }

  private typeInfoObject(rel: number, vars: DbDef["vars"], size?: number): Uint8Array {
    const attrs: Array<[number, PValue]> = size !== undefined ? [[Ids.TI_TComSize, new ValueUDInt(size)]] : [];
    return serializeTypeInfoObject(rel, 0x0abc, vars, attrs);
  }

  /** Test helper: this connection's TLS exporter secret. */
  tlsExporter(length: number, label: string): Uint8Array | null {
    return this.tlsSock ? new Uint8Array(this.tlsSock.exportKeyingMaterial(length, label, undefined as unknown as Buffer)) : null;
  }
}
