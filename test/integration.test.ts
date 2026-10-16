/*
 * End-to-end integration tests of the network layer (net/, tls/, S7CommPlusConnection, legitimation, browse,
 * subscriptions, alarms) against the in-process mock PLC in test/mock-plc/.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ByteStream, Ids, ItemAddress, LegitimationType, PObject, PlcTagBool, PlcTagByteArray, PlcTagDInt, PlcTagInt, PlcTagIntArray,
  PlcTagQC, PlcTagString, S7CommPlusConnection, S7Consts, Softdatatype, ValueBlob, ValueDInt, ValueInt, ValueStruct,
  ValueUDInt, ValueIntArray, ValueByteArray, ValueReal, PlcTagReal, PlcTagLReal, PlcTagUSInt, PlcTagLInt, PlcTagWord,
  PlcTagDWord, PlcTagUDInt, PlcTagByte,
  S7TlsChannel, S7Client, buildLegitimationPayload, LegitimationCrypto, ValueWString, ValueLWord, ValueUSInt, ValueUInt, ValueTimestamp, ValueBlobSparseArray, ValueSInt,
} from "../src/index.js";
import type { PlcTag, VarInfo } from "../src/index.js";
import { generateSelfSignedCert } from "./mock-plc/cert.js";
import { ERR_ADDRESS, ERR_NO_ACCESS, ERR_TYPE, MockPlc } from "./mock-plc/MockPlc.js";
import type { MockPlcOptions } from "./mock-plc/MockPlc.js";
import { AlarmBlobArray, buildAlarmNotification, buildCreateObjectResponse, buildGetMultiVariablesResponse, itemKey } from "./mock-plc/messages.js";

let plc: MockPlc;
const conns: S7CommPlusConnection[] = [];
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});

afterEach(async () => {
  for (const c of conns.splice(0)) {
    try {
      c.client?.disconnect();
    } catch {
      /* ignore */
    }
  }
  await plc?.stop();
  vi.restoreAllMocks();
});

async function startPlc(opts: Partial<MockPlcOptions> = {}): Promise<MockPlc> {
  plc = new MockPlc(opts);
  await plc.start();
  return plc;
}

interface ConnectOpts {
  password?: string;
  username?: string;
  timeoutMs?: number;
}

function newConn(port = plc.port): S7CommPlusConnection {
  const c = new S7CommPlusConnection();
  c.plcPort = port;
  conns.push(c);
  return c;
}

async function connect(o: ConnectOpts = {}): Promise<{ conn: S7CommPlusConnection; res: number }> {
  const conn = newConn();
  const res = await conn.connect("127.0.0.1", o.password ?? "", o.username ?? "", o.timeoutMs ?? 3000);
  return { conn, res };
}

async function connectOk(o: ConnectOpts = {}): Promise<S7CommPlusConnection> {
  const { conn, res } = await connect(o);
  expect(res, "connect result; violations=" + JSON.stringify(plc.violations)).toBe(0);
  return conn;
}

const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();
const sha1 = (s: string): Buffer => createHash("sha1").update(s, "utf8").digest();

function tag(conn: S7CommPlusConnection, symbol: string): Promise<PlcTag> {
  return conn.getPlcTagBySymbol(symbol).then((t) => {
    expect(t, "symbol " + symbol).not.toBeNull();
    return t as PlcTag;
  });
}

// ===================================================================================================================
describe("connect / disconnect", () => {
  it("establishes an ISO-on-TCP + TLS 1.3 + S7CommPlus session and tears it down", async () => {
    await startPlc();
    const conn = await connectOk();

    // COTP connection request as the C# driver sends it
    expect(plc.crInfos).toEqual([{ localTsap: 0x0600, remoteTsap: "SIMATIC-ROOT-HMI" }]);
    // a real TLS 1.3 handshake happened, with one of the two forced AES-GCM suites
    expect(plc.tlsInfo).toHaveLength(1);
    expect(plc.tlsInfo[0].protocol).toBe("TLSv1.3");
    expect(["TLS_AES_256_GCM_SHA384", "TLS_AES_128_GCM_SHA256"]).toContain(plc.tlsInfo[0].cipher);

    expect(conn.sessionId).toBe(0x7a00);
    expect(conn.sessionId2).toBe(0x7a01);
    expect(conn.client.connected).toBe(true);
    // SystemLimits were read during connect
    expect(conn.commResources.tagsPerReadRequestMax).toBe(20);
    expect(conn.commResources.tagsPerWriteRequestMax).toBe(20);
    expect(conn.commResources.plcSubscriptionsMax).toBe(32);
    expect(conn.commResources.plcAttributesMax).toBe(10000);
    expect(conn.commResources.subscriptionMemoryMax).toBe(65536);

    // exact request sequence of the connect flow
    expect(plc.requests.map((r) => r.kind)).toEqual([
      "InitSsl", "CreateObject", "SetMultiVariables", "GetMultiVariables", "GetVarSubstreamed",
    ]);
    expect(plc.requests.map((r) => r.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(plc.requests[0].version).toBe(1);
    expect(plc.requests[2].version).toBe(2);

    await conn.disconnect();
    expect(conn.client.connected).toBe(false);
    expect(conn.sessionId).toBe(0);
    expect(plc.requests.at(-1)!.kind).toBe("DeleteObject");
    expect(plc.violations).toEqual([]);
    expect(plc.tlsErrors).toEqual([]);
  });

  it("reports connection refused as errTCPConnectionFailed", async () => {
    const port = await MockPlc.unusedPort();
    plc = new MockPlc();
    const conn = newConn(port);
    expect(await conn.connect("127.0.0.1", "", "", 1000)).toBe(S7Consts.errTCPConnectionFailed);
    expect(conn.client.connected).toBe(false);
  });

  it("reports an unreachable/invalid host as errTCPConnectionFailed", async () => {
    plc = new MockPlc();
    const conn = newConn();
    conn.connTimeout = 300;
    expect(await conn.connect("256.0.0.1", "", "", 1000)).toBe(S7Consts.errTCPConnectionFailed);
  });

  it("reports a TCP connect timeout as errTCPConnectionFailed after the connect timeout", async () => {
    plc = new MockPlc();
    // a SYN that is never answered: the socket stays in the "connecting" state
    const spy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
      return this;
    });
    try {
      const conn = newConn(65000);
      conn.connTimeout = 250;
      const t0 = Date.now();
      expect(await conn.connect("127.0.0.1", "", "", 1000)).toBe(S7Consts.errTCPConnectionFailed);
      const dt = Date.now() - t0;
      expect(dt).toBeGreaterThanOrEqual(200);
      expect(dt).toBeLessThan(1000);
      expect(conn.client.connected).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("times out when the PLC never answers the COTP connection request", async () => {
    await startPlc({ cc: "none" });
    const conn = newConn();
    conn.isoRecvTimeout = 300;
    const t0 = Date.now();
    expect(await conn.connect("127.0.0.1", "", "", 1000)).toBe(S7Consts.errTCPDataReceive);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(conn.client.connected).toBe(false);
  });

  it("rejects a connection confirm of the wrong type with errIsoConnect", async () => {
    await startPlc({ cc: "wrongType" });
    const { res } = await connect();
    expect(res).toBe(S7Consts.errIsoConnect);
  });

  it("rejects a connection confirm of the wrong size with errIsoInvalidPDU", async () => {
    await startPlc({ cc: "wrongSize" });
    const { res } = await connect();
    expect(res).toBe(S7Consts.errIsoInvalidPDU);
  });

  it("fails fast with errTCPDataReceive when the PLC closes the connection instead of confirming", async () => {
    await startPlc({ cc: "close" });
    const conn = newConn();
    const t0 = Date.now();
    expect(await conn.connect("127.0.0.1", "", "", 1000)).toBe(S7Consts.errTCPDataReceive);
    expect(Date.now() - t0).toBeLessThan(1000); // not the 2 s ISO receive timeout
  });

  it("does not report success when the InitSsl answer is an unexpected PDU", async () => {
    await startPlc({ initSsl: "errorResponse" });
    const { res, conn } = await connect();
    expect(res).toBe(S7Consts.errIsoInvalidPDU);
    expect(conn.client.connected).toBe(false);
  });

  it("returns errTCPDataReceive when the InitSsl response never arrives", async () => {
    await startPlc({ initSsl: "none" });
    const { res, conn } = await connect({ timeoutMs: 300 });
    expect(res).toBe(S7Consts.errTCPDataReceive);
    expect(conn.client.connected).toBe(false);
  });

  it("returns an error when the PLC closes the connection during the TLS handshake", async () => {
    await startPlc({ tls: "close" });
    const { res, conn } = await connect({ timeoutMs: 400 });
    expect(res).not.toBe(0);
    expect(conn.client.connected).toBe(false);
  });

  it("returns an error (and does not crash) when the PLC answers the ClientHello with garbage", async () => {
    await startPlc({ tls: "garbage" });
    const { res, conn } = await connect({ timeoutMs: 400 });
    expect(res).not.toBe(0);
    expect(conn.client.connected).toBe(false);
  });

  it("returns errIsoInvalidPDU when the CreateObject answer is an error response", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "CreateObject" ? { error: true } : undefined) });
    expect((await connect()).res).toBe(S7Consts.errIsoInvalidPDU);
  });

  it("times out when the CreateObject answer never arrives", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "CreateObject" ? { drop: true } : undefined) });
    expect((await connect({ timeoutMs: 300 })).res).toBe(S7Consts.errTCPDataReceive);
  });

  it("returns errIsoInvalidPDU when the session setup answer is an error response", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "SetMultiVariables" ? { error: true } : undefined) });
    expect((await connect()).res).toBe(S7Consts.errIsoInvalidPDU);
  });

  it("disconnect() completes (after the read timeout) when the PLC does not answer DeleteObject", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "DeleteObject" ? { drop: true } : undefined) });
    const conn = await connectOk();
    conn.readTimeout = 300;
    const t0 = Date.now();
    await conn.disconnect();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(conn.client.connected).toBe(false);
  });

  it("can reconnect with the same connection object", async () => {
    await startPlc();
    const conn = await connectOk();
    await conn.disconnect();
    expect(await conn.connect("127.0.0.1", "", "", 3000)).toBe(0);
    const { res, values } = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(res).toBe(0);
    expect((values[0] as ValueDInt).getValue()).toBe(42);
    await conn.disconnect();
    expect(plc.violations).toEqual([]);
  });

  it("answers the unsupported firmware / device checks of the legitimation stage", async () => {
    const cases: Array<[string, number]> = [
      ["1;6ES7 511-1AK02-0AB0;V2.8", S7Consts.errCliFirmwareNotSupported],
      ["1;6ES7 212-1BE40-0XB0;V4.2", S7Consts.errCliFirmwareNotSupported],
      ["1;6ES7 672-7FC01-0YA0;V21.8", S7Consts.errCliFirmwareNotSupported],
      ["1;6ES7 311-1AK02-0AB0;V3.1", S7Consts.errCliDeviceNotSupported],
      ["garbage", S7Consts.errCliFirmwareNotSupported],
    ];
    for (const [fw, expected] of cases) {
      await startPlc({ firmware: fw });
      const { res } = await connect();
      expect(res, fw).toBe(expected);
      await plc.stop();
    }
  });
});

// ===================================================================================================================
describe("legitimation", () => {
  it("legacy login (S7-1500 FW 2.9): response = SHA1(password) xor challenge", async () => {
    await startPlc({ firmware: "1;6ES7 511-1AK02-0AB0;V2.9", password: "s3cret" });
    const conn = await connectOk({ password: "s3cret" });
    expect(plc.legitimations).toHaveLength(1);
    const l = plc.legitimations[0];
    expect(l.kind).toBe("legacy");
    expect(l.ok).toBe(true);
    // independent computation of the expected response
    const expected = Buffer.from(sha1("s3cret").map((b, i) => b ^ l.challenge[i]));
    expect(Buffer.from(l.blob).equals(expected)).toBe(true);
    expect(l.challenge).toHaveLength(20);
    // after the successful login the DB is readable
    const { values, errors } = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(errors[0]).toBe(0n);
    expect((values[0] as ValueDInt).getValue()).toBe(42);
    expect(plc.violations).toEqual([]);
  });

  it("known-answer vectors (computed with python + the openssl CLI from the C# algorithm: payload struct, key = SHA256(OMS), IV = challenge[0..16])", () => {
    const oms = Buffer.from("101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f", "hex");
    const iv = Buffer.from("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", "hex");
    expect(sha256(oms).toString("hex")).toBe("89c7460452eddff119fea0419e785c74de2ffb139dbe74323aca4a01e198a5dc");
    const vectors: Array<[string, string, string, string]> = [
      ["pw", "", "001700009dd082bb5100040182bb520014000082bb53001400141a91d62f7ca67399625a4368a6ab5d4a3baa607300",
        "5c5de4e4f9294031d0b59823e22a1abff79517c0eb668ca94911bb529d1273252bfeb6e7e0eb3c02054910f79b57e3f9"],
      ["Wonder!", "alice", "001700009dd082bb5100040282bb5200140005616c69636582bb5300140007576f6e6465722100",
        "8b944b87b935e88bc2356eeca58382e68ca288013dd3f6237b5747b9252b29310b84208b8f01909d7b1eeb702fb6a56e"],
    ];
    for (const [pw, user, plain, cipher] of vectors) {
      const p = buildLegitimationPayload(pw, user);
      expect(Buffer.from(p).toString("hex")).toBe(plain);
      expect(Buffer.from(LegitimationCrypto.encryptAesCbc(p, sha256(oms), iv)).toString("hex")).toBe(cipher);
    }
  });

  it("legacy login with a wrong password is denied (errCliAccessDenied) and the connection is closed", async () => {
    await startPlc({ firmware: "1;6ES7 511-1AK02-0AB0;V2.9", password: "s3cret" });
    const { res, conn } = await connect({ password: "wrong" });
    expect(res).toBe(S7Consts.errCliAccessDenied);
    expect(conn.client.connected).toBe(false);
    expect(plc.legitimations[0].ok).toBe(false);
  });

  it("new login without user name (FW 3.1): AES-256-CBC with SHA256(OMS exporter secret) and challenge IV", async () => {
    await startPlc({ firmware: "1;6ES7 511-1AK02-0AB0;V3.1", password: "pw-123" });
    const conn = await connectOk({ password: "pw-123" });
    const l = plc.legitimations[0];
    expect(l.kind).toBe("new");
    expect(l.ok).toBe(true);
    expect(l.payloadType).toBe(LegitimationType.Legacy); // empty user name => legacy payload inside the new login

    // The exporter secrets of both ends must agree (label "EXPERIMENTAL_OMS", no context, 32 bytes)
    const oms = plc.lastOmsSecret!;
    expect(oms).toHaveLength(32);
    // The client rolled its secret: omsSecret = SHA256(oms)
    expect(Buffer.from(conn.omsSecret!).equals(sha256(oms))).toBe(true);

    // Independently computed expected ciphertext:
    //   payload = Struct(LegitimationPayloadStruct){ Type=Legacy(1), Username=Blob(""), Password=Blob(SHA1(pw)) }
    const payload = new ValueStruct(Ids.LID_LegitimationPayloadStruct);
    payload.addStructElement(Ids.LID_LegitimationPayloadType, new ValueUDInt(1));
    payload.addStructElement(Ids.LID_LegitimationPayloadUsername, new ValueBlob(0, new Uint8Array(0)));
    payload.addStructElement(Ids.LID_LegitimationPayloadPassword, new ValueBlob(0, sha1("pw-123")));
    const bs = new ByteStream();
    payload.serialize(bs);
    const key = sha256(oms);
    const iv = Buffer.from(l.challenge.subarray(0, 16));
    const c = createCipheriv("aes-256-cbc", key, iv);
    const expected = Buffer.concat([c.update(bs.toArray()), c.final()]);
    expect(Buffer.from(l.blob).toString("hex")).toBe(expected.toString("hex"));
    expect(Buffer.from(l.key!).equals(key)).toBe(true);

    // second legitimation on the same connection uses the rolled key SHA256(SHA256(oms))
    expect(await conn.legitimateNew("pw-123")).toBe(0);
    const l2 = plc.legitimations[1];
    expect(l2.ok).toBe(true);
    expect(Buffer.from(l2.key!).equals(sha256(sha256(oms)))).toBe(true);
    expect(plc.violations).toEqual([]);
  });

  it("new login with user name: payload type New with plain user name and password", async () => {
    await startPlc({ firmware: "1;6ES7 511-1AK02-0AB0;V3.1", password: "x", users: new Map([["alice", "Wonder!"]]) });
    await connectOk({ password: "Wonder!", username: "alice" });
    const l = plc.legitimations[0];
    expect(l.payloadType).toBe(LegitimationType.New);
    expect(l.username).toBe("alice");
    expect(l.password).toBe("Wonder!");
    expect(l.ok).toBe(true);
    // independent expectation of the plaintext struct
    const payload = new ValueStruct(Ids.LID_LegitimationPayloadStruct);
    payload.addStructElement(Ids.LID_LegitimationPayloadType, new ValueUDInt(2));
    payload.addStructElement(Ids.LID_LegitimationPayloadUsername, new ValueBlob(0, Buffer.from("alice")));
    payload.addStructElement(Ids.LID_LegitimationPayloadPassword, new ValueBlob(0, Buffer.from("Wonder!")));
    const bs = new ByteStream();
    payload.serialize(bs);
    const c = createCipheriv("aes-256-cbc", sha256(plc.lastOmsSecret!), Buffer.from(l.challenge.subarray(0, 16)));
    expect(Buffer.from(l.blob).toString("hex")).toBe(Buffer.concat([c.update(bs.toArray()), c.final()]).toString("hex"));
  });

  it("new login with a wrong password is denied", async () => {
    await startPlc({ firmware: "1;6ES7 511-1AK02-0AB0;V3.1", password: "right" });
    const { res, conn } = await connect({ password: "wrong" });
    expect(res).toBe(S7Consts.errCliAccessDenied);
    expect(conn.client.connected).toBe(false);
  });

  it("picks the login variant from the firmware string", async () => {
    const cases: Array<[string, "legacy" | "new"]> = [
      ["1;6ES7 511-1AK02-0AB0;V2.9", "legacy"],
      ["1;6ES7 511-1AK02-0AB0;V3.0", "legacy"],
      ["1;6ES7 511-1AK02-0AB0;V3.1", "new"],
      ["1;6ES7 214-1AG40-0XB0 ;V4.5", "legacy"],
      ["1;6ES7 214-1AG40-0XB0 ;V4.7", "new"],
      ["1;6ES7 212-1HG50-0XB0;V1.0", "new"],
      ["1;6ES7 672-7FC01-0YA0;V21.9", "legacy"],
    ];
    for (const [fw, kind] of cases) {
      await startPlc({ firmware: fw, password: "pw" });
      await connectOk({ password: "pw" });
      expect(plc.legitimations.map((l) => l.kind), fw).toEqual([kind]);
      expect(plc.legitimations[0].ok, fw).toBe(true);
      await plc.stop();
    }
  });

  it("does not legitimate when the PLC is not protected", async () => {
    await startPlc({ password: null });
    await connectOk({ password: "ignored" });
    expect(plc.legitimations).toEqual([]);
    expect(plc.requests.map((r) => r.kind)).not.toContain("SetVariable");
  });

  it("connects without password to a protected PLC (warning only); data access is then refused", async () => {
    await startPlc({ password: "pw" });
    const conn = await connectOk();
    expect(logs.join("\n")).toContain("Access level is not fullaccess but no password set");
    const { res, values, errors } = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(res).toBe(0);
    expect(values[0]).toBeNull();
    expect(errors[0]).toBe(ERR_NO_ACCESS);
  });
});

// ===================================================================================================================
describe("browse", () => {
  it("lists the datablocks (filtered Explore + type info RID per DB), dropping DBs without type info", async () => {
    await startPlc();
    const conn = await connectOk();
    const { res, dbInfoList } = await conn.getListOfDatablocks();
    expect(res).toBe(0);
    expect(dbInfoList.map((d) => [d.db_name, d.db_number, d.db_block_relid, d.db_block_ti_relid])).toEqual([
      ["TestDB", 1, 0x8a0e0001, 0x00b00001],
      ["Other", 2, 0x8a0e0002, 0x00b00003],
    ]);
    const ex = plc.requests.filter((r) => r.kind === "Explore");
    expect(ex).toHaveLength(1);
    expect(plc.violations).toEqual([]);
  });

  it("browses the whole fake program into the flat variable list", async () => {
    await startPlc();
    const conn = await connectOk();
    const { res, varInfoList } = await conn.browse();
    expect(res).toBe(0);

    const S = Softdatatype;
    const expectedHead: Array<[string, string, number]> = [
      ["TestDB.flag", "8A0E0001.A", S.S7COMMP_SOFTDATATYPE_BOOL],
      ["TestDB.counter", "8A0E0001.B", S.S7COMMP_SOFTDATATYPE_INT],
      ["TestDB.bigNumber", "8A0E0001.C", S.S7COMMP_SOFTDATATYPE_DINT],
      ["TestDB.temperature", "8A0E0001.D", S.S7COMMP_SOFTDATATYPE_REAL],
      ["TestDB.name", "8A0E0001.E", S.S7COMMP_SOFTDATATYPE_STRING],
      ["TestDB.samples[0]", "8A0E0001.F.0", S.S7COMMP_SOFTDATATYPE_INT],
      ["TestDB.samples[1]", "8A0E0001.F.1", S.S7COMMP_SOFTDATATYPE_INT],
      ["TestDB.samples[2]", "8A0E0001.F.2", S.S7COMMP_SOFTDATATYPE_INT],
      ["TestDB.samples[3]", "8A0E0001.F.3", S.S7COMMP_SOFTDATATYPE_INT],
      ["TestDB.motor.speed", "8A0E0001.10.1", S.S7COMMP_SOFTDATATYPE_LREAL],
      ["TestDB.motor.running", "8A0E0001.10.2", S.S7COMMP_SOFTDATATYPE_BOOL],
      ["TestDB.motor.mode", "8A0E0001.10.3", S.S7COMMP_SOFTDATATYPE_BYTE],
      ["TestDB.word", "8A0E0001.11", S.S7COMMP_SOFTDATATYPE_WORD],
      ["TestDB.dword", "8A0E0001.12", S.S7COMMP_SOFTDATATYPE_DWORD],
      ["TestDB.lreal", "8A0E0001.13", S.S7COMMP_SOFTDATATYPE_LREAL],
      ["TestDB.lint", "8A0E0001.14", S.S7COMMP_SOFTDATATYPE_LINT],
      ["TestDB.usint", "8A0E0001.15", S.S7COMMP_SOFTDATATYPE_USINT],
      ["TestDB.udint", "8A0E0001.16", S.S7COMMP_SOFTDATATYPE_UDINT],
      ["TestDB.shortText", "8A0E0001.17", S.S7COMMP_SOFTDATATYPE_STRING],
    ];
    const head = varInfoList.slice(0, expectedHead.length).map((v) => [v.name, v.accessSequence, v.softdatatype]);
    expect(head).toEqual(expectedHead);
    // 2000 byte array elements, then DB "Other"
    const bytesList = varInfoList.slice(expectedHead.length, expectedHead.length + 2000);
    expect(bytesList[0].name).toBe("TestDB.bytes[0]");
    expect(bytesList[1999].name).toBe("TestDB.bytes[1999]");
    expect(bytesList[255].accessSequence).toBe("8A0E0001.18.FF");
    expect(bytesList[256].accessSequence).toBe("8A0E0001.18.100");
    expect(varInfoList).toHaveLength(expectedHead.length + 2000 + 1);
    expect(varInfoList.at(-1)).toMatchObject({ name: "Other.value", accessSequence: "8A0E0002.A" });

    // byte offsets (optimized) accumulate like Browser.cs: struct offset + member offset, array base + index * size
    const byName = new Map<string, VarInfo>(varInfoList.slice(0, expectedHead.length).map((v) => [v.name, v]));
    expect(byName.get("TestDB.counter")!.optAddress).toBe(2);
    expect(byName.get("TestDB.bigNumber")!.optAddress).toBe(4);
    expect(byName.get("TestDB.samples[2]")!.optAddress).toBe(270 + 2 * 2);
    expect(byName.get("TestDB.motor.speed")!.optAddress).toBe(280);
    expect(byName.get("TestDB.motor.mode")!.optAddress).toBe(280 + 9);
    expect(plc.violations).toEqual([]);
  });

  it("resolves symbols (incl. array elements and struct members) to PlcTags with the right access sequence", async () => {
    await startPlc();
    const conn = await connectOk();
    const cases: Array<[string, string, new (...a: never[]) => PlcTag]> = [
      ["TestDB.counter", "8A0E0001.B", PlcTagInt],
      ['"TestDB".counter', "8A0E0001.B", PlcTagInt],
      ["TestDB.samples[2]", "8A0E0001.F.2", PlcTagInt],
      ["TestDB.samples", "8A0E0001.F", PlcTagIntArray],
      ["TestDB.motor.speed", "8A0E0001.10.1", PlcTagLReal],
      ["Other.value", "8A0E0002.A", PlcTagDInt],
    ];
    for (const [sym, access, cls] of cases) {
      const t = await tag(conn, sym);
      expect(t.address.getAccessString(), sym).toBe(access);
      expect(t, sym).toBeInstanceOf(cls);
    }
    expect(await conn.getPlcTagBySymbol("TestDB.doesNotExist")).toBeNull();
    expect(await conn.getPlcTagBySymbol("NoSuchDb.x")).toBeNull();
    await expect(conn.getPlcTagBySymbol("TestDB.samples[9]")).rejects.toThrow("Out of bounds");
    // type info is cached: no further Explore for the already known DB and struct type info
    const before = plc.requests.filter((r) => r.kind === "Explore").length;
    await tag(conn, "TestDB.motor.running");
    await tag(conn, "TestDB.motor.mode");
    await tag(conn, "TestDB.counter");
    const after = plc.requests.filter((r) => r.kind === "Explore").length;
    expect(after - before).toBe(0);
  });

  it("surfaces missing type info as an exception", async () => {
    await startPlc();
    const conn = await connectOk();
    plc.structs.length = 0; // struct type info vanishes => Explore returns an error / no object
    await expect(conn.getPlcTagBySymbol("TestDB.motor.speed")).rejects.toThrow();
  });
});

// ===================================================================================================================
describe("read / write values through PlcTag", () => {
  it("reads all kinds of tags", async () => {
    await startPlc();
    const conn = await connectOk();
    const names = [
      "TestDB.flag", "TestDB.counter", "TestDB.bigNumber", "TestDB.temperature", "TestDB.name", "TestDB.samples[1]",
      "TestDB.samples", "TestDB.motor.speed", "TestDB.motor.running", "TestDB.motor.mode", "TestDB.word", "TestDB.dword",
      "TestDB.lreal", "TestDB.lint", "TestDB.usint", "TestDB.udint", "Other.value",
    ];
    const tags: PlcTag[] = [];
    for (const n of names) tags.push(await tag(conn, n));
    expect(await conn.readTags(tags)).toBe(0);
    for (const t of tags) expect(t.quality, t.name).toBe(PlcTagQC.TAG_QUALITY_GOOD);
    const v = (n: string): unknown => (tags[names.indexOf(n)] as PlcTag & { value: unknown }).value;
    expect(v("TestDB.flag")).toBe(true);
    expect(v("TestDB.counter")).toBe(-1234);
    expect(v("TestDB.bigNumber")).toBe(123456789);
    expect(v("TestDB.temperature")).toBeCloseTo(21.5, 5);
    expect(v("TestDB.name")).toBe("hello plc");
    expect(v("TestDB.samples[1]")).toBe(101);
    expect(v("TestDB.samples")).toEqual([100, 101, 102, 103]);
    expect(v("TestDB.motor.speed")).toBe(1500.25);
    expect(v("TestDB.motor.running")).toBe(false);
    expect(v("TestDB.motor.mode")).toBe(7);
    expect(v("TestDB.word")).toBe(0xbeef);
    expect(v("TestDB.dword")).toBe(0xdeadbeef);
    expect(v("TestDB.lreal")).toBe(-0.5);
    expect(v("TestDB.lint")).toBe(-9007199254740993n);
    expect(v("TestDB.usint")).toBe(200);
    expect(v("TestDB.udint")).toBe(4000000000);
    expect(v("Other.value")).toBe(42);
    expect(plc.violations).toEqual([]);
  });

  it("write -> read round trips for several types and the PLC memory sees the right PValues", async () => {
    await startPlc();
    const conn = await connectOk();
    const mk = async <T extends PlcTag>(sym: string): Promise<T & { value: any }> => (await tag(conn, sym)) as T & { value: any };

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
    const all = [flag, counter, big, temp, name, smp, speed, word, dword, lint, usint, udint, mode];
    expect(await conn.writeTags(all)).toBe(0);
    for (const t of all) expect(t.lastWriteError, t.name).toBe(0n);

    // fresh tags read back what was written
    const names = all.map((t) => t.name);
    const fresh: PlcTag[] = [];
    for (const n of names) fresh.push(await tag(conn, n));
    expect(await conn.readTags(fresh)).toBe(0);
    for (let i = 0; i < all.length; i++) {
      expect(fresh[i].quality, names[i]).toBe(PlcTagQC.TAG_QUALITY_GOOD);
      const a = (fresh[i] as any).value;
      const b = all[i].value;
      if (typeof b === "number" && names[i].endsWith("temperature")) expect(a).toBeCloseTo(b, 3);
      else expect(a, names[i]).toEqual(b);
    }
    expect(plc.memory.get("8A0E0001.F")).toBeInstanceOf(ValueIntArray);
    expect(plc.memory.get("8A0E0001.B")).toBeInstanceOf(ValueInt);
    expect(plc.violations).toEqual([]);
  });

  it("writes a String[20] and a 2000 byte array (request fragmented over 3 S7+ fragments)", async () => {
    await startPlc();
    const conn = await connectOk();
    const st = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
    st.value = "twenty chars string!";
    const bytes = (await tag(conn, "TestDB.bytes")) as PlcTagByteArray;
    expect(bytes).toBeInstanceOf(PlcTagByteArray);
    bytes.value = Uint8Array.from({ length: 2000 }, (_, i) => (i * 13 + 5) & 0xff);
    expect(await conn.writeTags([st, bytes])).toBe(0);
    expect(st.lastWriteError).toBe(0n);
    expect(bytes.lastWriteError).toBe(0n);
    expect(Math.max(...plc.requestFragments)).toBeGreaterThanOrEqual(3);

    const st2 = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
    const b2 = (await tag(conn, "TestDB.bytes")) as PlcTagByteArray;
    expect(await conn.readTags([st2, b2])).toBe(0);
    expect(st2.value).toBe("twenty chars string!");
    expect(Buffer.from(b2.value).equals(Buffer.from(bytes.value))).toBe(true);
    expect(plc.violations).toEqual([]);
  });

  it("reports per-item errors: wrong datatype/size on write, unknown address on read", async () => {
    await startPlc();
    const conn = await connectOk();
    // A DInt tag at the address of an Int variable
    const wrong = new PlcTagDInt("wrong", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_DINT);
    wrong.value = 5;
    const good = await tag(conn, "TestDB.counter") as PlcTagInt;
    good.value = 77;
    expect(await conn.writeTags([wrong, good])).toBe(0);
    expect(wrong.lastWriteError).toBe(ERR_TYPE);
    expect(good.lastWriteError).toBe(0n);
    expect((plc.memory.get("8A0E0001.B") as ValueInt).getValue()).toBe(77);

    const missing = new PlcTagInt("missing", new ItemAddress("8A0E0001.99"), Softdatatype.S7COMMP_SOFTDATATYPE_INT);
    const ok = await tag(conn, "TestDB.counter");
    expect(await conn.readTags([missing, ok])).toBe(0);
    expect(missing.lastReadError).toBe(ERR_ADDRESS);
    expect(missing.quality).toBe(PlcTagQC.TAG_QUALITY_BAD);
    expect(ok.quality).toBe(PlcTagQC.TAG_QUALITY_GOOD);

    // type mismatch on read: a Real tag on an Int value => bad quality, not an exception
    const mism = new PlcTagReal("mism", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_REAL);
    expect(await conn.readTags([mism])).toBe(0);
    expect(mism.quality).toBe(PlcTagQC.TAG_QUALITY_BAD);
  });

  it("splits requests according to the PLC's SystemLimits (read and write chunking)", async () => {
    await startPlc({ tagsPerReadRequestMax: 3, tagsPerWriteRequestMax: 2 });
    const conn = await connectOk();
    expect(conn.commResources.tagsPerReadRequestMax).toBe(3);
    const addrs = ["8A0E0001.A", "8A0E0001.B", "8A0E0001.C", "8A0E0001.D", "8A0E0001.99", "8A0E0001.11", "8A0E0002.A"].map((a) => new ItemAddress(a));
    const before = plc.requests.filter((r) => r.kind === "GetMultiVariables").length;
    const { res, values, errors } = await conn.readValues(addrs);
    expect(res).toBe(0);
    expect(plc.requests.filter((r) => r.kind === "GetMultiVariables").length - before).toBe(3);
    expect(values.map((v) => (v as { getValue(): unknown } | null)?.getValue())).toEqual([true, -1234, 123456789, 21.5, undefined, 0xbeef, 42]);
    expect(errors).toEqual([0n, 0n, 0n, 0n, ERR_ADDRESS, 0n, 0n]);

    const waddrs = ["8A0E0001.B", "8A0E0001.C", "8A0E0001.99", "8A0E0001.11", "8A0E0001.A"].map((a) => new ItemAddress(a));
    const vals = [new ValueInt(1), new ValueDInt(2), new ValueInt(3), new ValueInt(4), new ValueDInt(5)];
    const wb = plc.requests.filter((r) => r.kind === "SetMultiVariables").length;
    const w = await conn.writeValues(waddrs, vals);
    expect(w.res).toBe(0);
    expect(plc.requests.filter((r) => r.kind === "SetMultiVariables").length - wb).toBe(3);
    // item 3 unknown address, item 4 (Word<-Int) and item 5 (Bool<-DInt) wrong type
    expect(w.errors).toEqual([0n, 0n, ERR_ADDRESS, ERR_TYPE, ERR_TYPE]);
    expect(plc.violations).toEqual([]);
  });

  it("reads datablock comments (Explore with attributes, zlib blob decompression)", async () => {
    await startPlc();
    const conn = await connectOk();
    const r = await conn.getCommentsXml(0x8a0e0001);
    expect(r.res).toBe(0);
    expect(r.xmlDbcomment).toBe(
      '<Value type ="WStringSparseArray"><Value key="1032">DB Kommentar</Value><Value key="1034">DB comment</Value></Value>',
    );
    expect(r.xmlLinecomment).toBe(
      '<InterfaceLineComments><Part Kind="Comments"><Comment Path="A"><DictEntry Language="de-DE">Zaehler</DictEntry></Comment></Part></InterfaceLineComments>',
    );
  });

  it("sets the PLC operating state through SetVariable", async () => {
    await startPlc();
    const conn = await connectOk();
    expect(await conn.setPlcOperatingState(3)).toBe(0);
    expect(plc.operatingState).toBe(3);
  });
});

// ===================================================================================================================
describe("request serialisation", () => {
  it("runs concurrent requests strictly one after the other with matching responses", async () => {
    await startPlc({ responseDelay: (r) => (r.sequenceNumber * 7) % 23 });
    const conn = await connectOk();
    const jobs: Array<Promise<unknown>> = [];
    const expected: Array<() => void> = [];
    for (let i = 0; i < 12; i++) {
      const lid = [0xa, 0xb, 0xc, 0xd][i % 4];
      const exp = [true, -1234, 123456789, 21.5][i % 4];
      jobs.push(
        conn.readValues([new ItemAddress("8A0E0001." + lid.toString(16))]).then((r) => {
          expect(r.res).toBe(0);
          expect((r.values[0] as unknown as { getValue(): number }).getValue()).toBeCloseTo(exp as number, 3);
        }),
      );
      expected.push(() => undefined);
      if (i % 3 === 0) {
        jobs.push(conn.writeValues([new ItemAddress("8A0E0002.A")], [new ValueDInt(1000 + i)]).then((r) => expect(r.res).toBe(0)));
      }
      if (i % 5 === 0) jobs.push(conn.getListOfDatablocks().then((r) => expect(r.dbInfoList).toHaveLength(2)));
    }
    jobs.push(conn.browse().then((r) => expect(r.res).toBe(0)));
    await Promise.all(jobs);
    expect(plc.maxOutstanding).toBe(1);
    expect(plc.violations).toEqual([]);
    // sequence numbers are consecutive over all requests
    const seqs = plc.requests.map((r) => r.sequenceNumber);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // the last write wins in order of submission
    expect((plc.memory.get("8A0E0002.A") as ValueDInt).getValue()).toBe(1009);
  });
});

// ===================================================================================================================
describe("receive path: reassembly of fragmented PDUs", () => {
  async function exercise(conn: S7CommPlusConnection): Promise<void> {
    const t = (await tag(conn, "TestDB.bytes")) as PlcTagByteArray;
    expect(await conn.readTags([t])).toBe(0);
    expect(t.quality).toBe(PlcTagQC.TAG_QUALITY_GOOD);
    expect(Buffer.from(t.value).equals(Buffer.from((plc.memory.get("8A0E0001.18") as ValueByteArray).getValue()))).toBe(true);
    const b = await conn.browse();
    expect(b.res).toBe(0);
    expect(b.varInfoList).toHaveLength(19 + 2000 + 1);
  }

  it("S7+ PDUs larger than one fragment (default fragment size 1000)", async () => {
    await startPlc();
    const conn = await connectOk();
    await exercise(conn);
    expect(Math.max(...plc.responseFragments)).toBeGreaterThanOrEqual(3);
    expect(plc.violations).toEqual([]);
  });

  it("tiny S7+ fragments (97 bytes)", async () => {
    await startPlc({ maxFragmentData: 97 });
    const conn = await connectOk();
    await exercise(conn);
    expect(Math.max(...plc.responseFragments)).toBeGreaterThan(20);
  });

  it("TLS output cut into 61 byte COTP DT TPDUs (EOT only on the last)", async () => {
    await startPlc({ tpduPayloadMax: 61 });
    const conn = await connectOk();
    await exercise(conn);
    expect(plc.violations).toEqual([]);
  });

  it("TCP segments of 5 bytes (TPKT headers and TLS records split across segments)", async () => {
    await startPlc({ tcpSegmentSize: 5, maxFragmentData: 300 });
    const conn = await connectOk({ timeoutMs: 20000 });
    const t = (await tag(conn, "TestDB.counter")) as PlcTagInt;
    expect(await conn.readTags([t])).toBe(0);
    expect(t.value).toBe(-1234);
  }, 30000);

  it("fragments combined: tiny fragments + small TPDUs + TCP segmentation", async () => {
    await startPlc({ maxFragmentData: 211, tpduPayloadMax: 128, tcpSegmentSize: 53 });
    const conn = await connectOk();
    const t = (await tag(conn, "TestDB.bytes")) as PlcTagByteArray;
    expect(await conn.readTags([t])).toBe(0);
    expect(t.value).toHaveLength(2000);
    expect(plc.violations).toEqual([]);
  });

  it("several S7+ fragments packed into one TLS record", async () => {
    await startPlc({ fragmentWrite: "coalesced", maxFragmentData: 400 });
    const conn = await connectOk();
    await exercise(conn);
  });

  it("an S7+ fragment spread over two TLS records", async () => {
    await startPlc({ fragmentWrite: "split", maxFragmentData: 400 });
    const conn = await connectOk();
    await exercise(conn);
  });
});

// ===================================================================================================================
describe("error paths after connect", () => {
  it("returns errTCPDataReceive when the PLC does not answer a read", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "GetMultiVariables" && r.addresses[0].accessArea === 0x8a0e0001 ? { drop: true } : undefined) });
    const conn = await connectOk();
    conn.readTimeout = 250;
    const r = await conn.readValues([new ItemAddress("8A0E0001.A")]);
    expect(r.res).toBe(S7Consts.errTCPDataReceive);
    // the connection stays usable for the next request
    conn.readTimeout = 2000;
    const r2 = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(r2.res).toBe(0);
  });

  it("returns errIsoInvalidPDU for an error response / wrong sequence number", async () => {
    let n = 0;
    await startPlc({
      onRequest: (r) => {
        if (r.kind !== "GetMultiVariables" || r.addresses[0].accessArea !== 0x8a0e0001) return undefined;
        n++;
        if (n === 1) return { error: true };
        return { raw: buildGetMultiVariablesResponse(r.sequenceNumber + 7, 0, 0n, new Map(), new Map()) };
      },
    });
    const conn = await connectOk();
    expect((await conn.readValues([new ItemAddress("8A0E0001.A")])).res).toBe(S7Consts.errIsoInvalidPDU);
    expect((await conn.readValues([new ItemAddress("8A0E0001.A")])).res).toBe(S7Consts.errIsoInvalidPDU);
    expect(logs.join("\n")).toContain("SeqenceNumber of Response");
    expect((await conn.readValues([new ItemAddress("8A0E0002.A")])).res).toBe(0);
  });

  it("a wrong IntegrityId is only logged, not an error", async () => {
    await startPlc({
      onRequest: (r) =>
        r.kind === "GetMultiVariables" && r.addresses[0].accessArea === 0x8a0e0001
          ? { raw: buildGetMultiVariablesResponse(r.sequenceNumber, 12345, 0n, new Map([[1, new ValueInt(3)]]), new Map()) }
          : undefined,
    });
    const conn = await connectOk();
    const r = await conn.readValues([new ItemAddress("8A0E0001.A")]);
    expect(r.res).toBe(0);
    expect((r.values[0] as ValueInt).getValue()).toBe(3);
    expect(logs.join("\n")).toContain("IntegrityId of the Response");
  });

  it("detects the PLC closing the connection: requests fail with a timeout, client reports disconnected", async () => {
    await startPlc({ onRequest: (r) => (r.kind === "GetMultiVariables" && r.addresses[0].accessArea === 0x8a0e0001 ? { close: true } : undefined) });
    const conn = await connectOk();
    conn.readTimeout = 300;
    const r = await conn.readValues([new ItemAddress("8A0E0001.A")]);
    expect(r.res).toBe(S7Consts.errTCPDataReceive);
    expect(conn.client.connected).toBe(false);
    const w = await conn.writeValues([new ItemAddress("8A0E0001.B")], [new ValueInt(1)]);
    expect(w.res).not.toBe(0);
  });

  it("a read after disconnect() fails instead of hanging", async () => {
    await startPlc();
    const conn = await connectOk();
    await conn.disconnect();
    conn.readTimeout = 2000;
    const t0 = Date.now();
    const r = await conn.readValues([new ItemAddress("8A0E0001.A")]);
    expect(r.res).toBe(S7Consts.errTCPNotConnected);
    expect(Date.now() - t0).toBeLessThan(500); // fails right away, does not wait for the read timeout
    const w = await conn.writeValues([new ItemAddress("8A0E0001.B")], [new ValueInt(1)]);
    expect(w.res).toBe(S7Consts.errTCPNotConnected);
  });

  it("disconnect() is harmless when never connected and when called twice", async () => {
    await startPlc();
    const never = newConn();
    await never.disconnect();
    const conn = await connectOk();
    await conn.disconnect();
    const t0 = Date.now();
    await conn.disconnect();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(plc.requests.filter((r) => r.kind === "DeleteObject")).toHaveLength(1);
  });

  it("wraps the sequence number (0xFFFF -> 1) and the integrity ids (0xFFFFFFFF -> 0)", async () => {
    await startPlc();
    const conn = await connectOk();
    const c = conn as unknown as { sequenceNumber: number; integrityId: number; integrityIdSet: number };
    c.sequenceNumber = 0xfffd;
    c.integrityId = 0xfffffffe;
    c.integrityIdSet = 0xfffffffe;
    // the mock follows the same counters: tell it where the client is
    const pc = [...plc.connections][0] as unknown as { lastSeq: number; integrity: { normal: number; set: number } };
    pc.lastSeq = 0xfffd;
    pc.integrity.normal = 0xfffffffe;
    pc.integrity.set = 0xfffffffe;
    for (let i = 0; i < 4; i++) {
      expect((await conn.readValues([new ItemAddress("8A0E0002.A")])).res).toBe(0);
      expect((await conn.writeValues([new ItemAddress("8A0E0002.A")], [new ValueDInt(i)])).res).toBe(0);
    }
    const seqs = plc.requests.slice(-8).map((r) => r.sequenceNumber);
    expect(seqs).toEqual([0xfffe, 0xffff, 1, 2, 3, 4, 5, 6]);
    expect(plc.requests.slice(-8).map((r) => r.integrityId)).toEqual([0xffffffff, 0xffffffff, 0, 0, 1, 1, 2, 2]);
    expect(plc.violations).toEqual([]);
    expect(logs.join("\n")).not.toContain("doesn't match");
  });

  it("ignores a SystemEvent message (protocol 0xFE) and keeps working", async () => {
    await startPlc();
    const conn = await connectOk();
    await plc.sendSystemEventMessage("some diagnostic text");
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.join("\n")).toContain("SystemEvent received");
    expect(logs.join("\n")).toContain("non fatal");
    const r = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(r.res).toBe(0);
  });

  it("survives a malformed SystemEvent PDU (decoder exception inside the receive handler)", async () => {
    await startPlc();
    const conn = await connectOk();
    const c = [...plc.connections][0];
    const body = Uint8Array.from([
      ...new Array(16).fill(0), // 4 reserved u32
      0, 0, 0, 0x17, // looks like a struct => binary coded data follows
      0, 0, 0, 5, // struct id
      0, 0, 0, 1, // element id
      0x00, 0x10, 0x00, 0x17, // element value: array flag + struct datatype => decoder throws NotImplemented
    ]);
    const hdr = Uint8Array.from([0x72, 0xfe, 0, body.length]);
    await c.writeApp(Buffer.concat([hdr, body]));
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.lastError).toBe(S7Consts.errIsoInvalidPDU);
    const r = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(r.res).toBe(0);
  });

  it("does not choke on a PDU with a bad S7+ header from the PLC", async () => {
    await startPlc();
    const conn = await connectOk();
    const c = [...plc.connections][0];
    await c.writeApp(Uint8Array.from([0x55, 0x02, 0x00, 0x00]));
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.lastError).toBe(S7Consts.errIsoInvalidPDU);
    const r = await conn.readValues([new ItemAddress("8A0E0002.A")]);
    expect(r.res).toBe(0);
  });
});

// ===================================================================================================================
describe("subscriptions", () => {
  it("creates a subscription, receives the initial and change notifications, extends the credit limit, deletes it", async () => {
    await startPlc();
    const conn = await connectOk();
    const counter = (await tag(conn, "TestDB.counter")) as PlcTagInt;
    const temp = (await tag(conn, "TestDB.temperature")) as PlcTagReal;
    const arr = (await tag(conn, "TestDB.samples[1]")) as PlcTagInt;

    expect(await conn.subscriptionCreate([counter, temp, arr], 100)).toBe(0);
    const creq = plc.requests.filter((r) => r.kind === "CreateObject").at(-1)!;
    if (creq.kind !== "CreateObject") throw new Error();
    expect(creq.requestId).toBe(conn.sessionId2);
    expect(creq.object.classId).toBe(Ids.ClassSubscription);
    expect((creq.object.attributes.get(Ids.SubscriptionCycleTime) as ValueUDInt).getValue()).toBe(100);

    // initial notification contains all subscribed values
    expect(await conn.testWaitForVariableChangeNotifications(1)).toBe(0);
    expect(counter.quality).toBe(PlcTagQC.TAG_QUALITY_GOOD);
    expect(counter.value).toBe(-1234);
    expect(temp.value).toBeCloseTo(21.5, 5);
    expect(arr.value).toBe(101);

    // the PLC changes a value => change notification with only that item
    plc.setValue("8A0E0001.B", new ValueInt(4711));
    expect(await conn.testWaitForVariableChangeNotifications(1)).toBe(0);
    expect(counter.value).toBe(4711);
    expect(temp.value).toBeCloseTo(21.5, 5);

    // 8 more changes: the credit tick reaches limit-1 (9) => the client raises the credit limit to 15 (no-response SetVariable)
    for (let i = 0; i < 8; i++) {
      plc.setValue("8A0E0001.B", new ValueInt(5000 + i));
      expect(await conn.testWaitForVariableChangeNotifications(1)).toBe(0);
    }
    expect(counter.value).toBe(5007);
    await vi.waitFor(() => {
      const sub = [...plc.connections][0].subscription([...plc.connections][0].subscriptionIds[0])!;
      expect(sub.creditLimit).toBe(15);
    });

    expect(await conn.subscriptionDelete()).toBe(0);
    expect([...plc.connections][0].subscriptionIds).toEqual([]);
    expect(plc.violations).toEqual([]);
  });

  it("returns errCliInvalidParams when the PLC refuses the subscription", async () => {
    await startPlc({
      onRequest: (r) =>
        r.kind === "CreateObject" && r.object.classId === Ids.ClassSubscription
          ? { raw: buildCreateObjectResponse(r.sequenceNumber, 0x8104n, [], new PObject(0, 0, 0)) }
          : undefined,
    });
    const conn = await connectOk();
    const counter = (await tag(conn, "TestDB.counter")) as PlcTagInt;
    expect(await conn.subscriptionCreate([counter], 100)).toBe(S7Consts.errCliInvalidParams);
  });

  it("times out waiting for notifications that never come", async () => {
    await startPlc({ initialNotification: false });
    const conn = await connectOk();
    const counter = (await tag(conn, "TestDB.counter")) as PlcTagInt;
    expect(await conn.subscriptionCreate([counter], 100)).toBe(0);
    // testWaitForVariableChangeNotifications waits 5 s; shorten by not awaiting the full period:
    const p = conn.testWaitForVariableChangeNotifications(1);
    await new Promise((r) => setTimeout(r, 100));
    plc.setValue("8A0E0001.B", new ValueInt(1));
    expect(await p).toBe(0);
    expect(counter.value).toBe(1);
  });

  it("creates and deletes an alarm subscription", async () => {
    await startPlc();
    const conn = await connectOk();
    expect(await conn.alarmSubscriptionCreate()).toBe(0);
    const creq = plc.requests.filter((r) => r.kind === "CreateObject").at(-1)!;
    if (creq.kind !== "CreateObject") throw new Error();
    expect(creq.requestId).toBe(conn.sessionId2);
    expect(creq.object.getObjects()).toHaveLength(1);
    expect(creq.object.getObjects()[0].classId).toBe(Ids.AlarmSubscriptionRef_Class_Rid);
    expect(await conn.alarmSubscriptionDelete()).toBe(0);
    expect(plc.violations).toEqual([]);
  });
});

describe("alarms", () => {
  it("receives an alarm notification and decodes it into an AlarmsDai", async () => {
    await startPlc();
    const conn = await connectOk();
    expect(await conn.alarmSubscriptionCreate()).toBe(0);

    const o = new PObject(0x1234, Ids.DAI_Class_Rid, 0);
    o.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("DAI_Test"));
    o.addAttribute(Ids.DAI_CPUAlarmID, new ValueLWord(0x1122334455667788n));
    o.addAttribute(Ids.DAI_AllStatesInfo, new ValueUSInt(0x05));
    o.addAttribute(Ids.DAI_AlarmDomain, new ValueUInt(3));
    o.addAttribute(Ids.DAI_MessageType, new ValueDInt(7));
    // HmiInfo blob: syntax 258, version 1, client alarm id 0xAABB, priority 4, 3 reserved, class 0x0102, producer, group, flags
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
        { rootId: Ids.AS_CGS_AssociatedValues, bytes: Uint8Array.from([0, 1, 0, 0]) }, // index 0: type information
        { rootId: Ids.TI_INT, bytes: Uint8Array.from([0xff, 0xfe]) }, // SD_1 = -2
        { rootId: Ids.TI_DINT, bytes: Uint8Array.from([0x00, 0x00, 0x01, 0x00]) }, // SD_2 = 256
        { rootId: Ids.TI_BOOL, bytes: Uint8Array.from([1]) }, // SD_3 = true
        { rootId: 0x020a0000 + 20, bytes: Uint8Array.from([20, 5, ...Buffer.from("hello")]) }, // SD_4 = String[20] "hello"
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

    const c = [...plc.connections][0];
    const subId = c.subscriptionIds[0];
    const waiting = conn.testWaitForAlarmNotifications(3000, 1, 1031);
    await c.sendRawNotification(buildAlarmNotification(subId, 0, 0, o));
    expect(await waiting).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("<ObjectVariableTypeName>DAI_Test</ObjectVariableTypeName>");
    expect(out).toContain("<CpuAlarmId>1234605616436508552</CpuAlarmId>");
    expect(out).toContain("<AlarmText>Motor overload</AlarmText>");
    expect(out).not.toContain("(en)");
    expect(out).toContain("<ClientAlarmId>43707</ClientAlarmId>");
    expect(out).toContain("<SD_1>");
    expect(out).toContain("-2");
    expect(out).toContain("hello");
  });

  it("waiting for alarm notifications times out with errTCPDataReceive when none arrives", async () => {
    await startPlc();
    const conn = await connectOk();
    expect(await conn.alarmSubscriptionCreate()).toBe(0);
    expect(await conn.testWaitForAlarmNotifications(200, 1, 1031)).toBe(S7Consts.errTCPDataReceive);
  });
});

void itemKey;
void ValueSInt;
void ValueByteArray;


// ===================================================================================================================
// The TLS layer against the real OpenSSL (openssl s_server) instead of Node's own TLS server
const haveOpenssl = (() => {
  try {
    return existsSync("/usr/bin/openssl") || existsSync("/usr/local/bin/openssl");
  } catch {
    return false;
  }
})();

describe.skipIf(!haveOpenssl)("TLS channel against OpenSSL s_server", () => {
  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  }

  async function run(ciphersuites: string): Promise<{ out: () => string; kill: () => void; port: number }> {
    const dir = mkdtempSync(join(tmpdir(), "s7-ossl-"));
    const { key, cert } = generateSelfSignedCert();
    writeFileSync(join(dir, "k.pem"), key);
    writeFileSync(join(dir, "c.pem"), cert);
    const port = await freePort();
    const child = spawn(
      "openssl",
      ["s_server", "-tls1_3", "-cert", join(dir, "c.pem"), "-key", join(dir, "k.pem"), "-accept", String(port), "-ciphersuites", ciphersuites,
       "-keymatexport", "EXPERIMENTAL_OMS", "-keymatexportlen", "32", "-naccept", "1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (buf += d));
    await new Promise((r) => setTimeout(r, 400));
    return { out: () => buf, kill: () => { child.kill(); rmSync(dir, { recursive: true, force: true }); }, port };
  }

  function bridge(port: number): { chan: S7TlsChannel; sock: net.Socket } {
    const sock = net.connect(port, "127.0.0.1");
    sock.setNoDelay(true);
    const chan = new S7TlsChannel({
      writeData: (d) => void sock.write(d),
      onData: () => undefined,
    });
    sock.on("data", (d) => chan.feed(d));
    sock.on("error", () => undefined);
    return { chan, sock };
  }

  it("completes a TLS 1.3 handshake and exports the same OMS secret as OpenSSL (label EXPERIMENTAL_OMS, no context)", async () => {
    const srv = await run("TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256");
    try {
      const { chan, sock } = bridge(srv.port);
      await chan.handshake;
      await chan.write(Buffer.from("ping\n"));
      const mine = Buffer.from(chan.getOMSExporterSecret()).toString("hex").toUpperCase();
      await vi.waitFor(() => expect(srv.out()).toContain("Keying material:"), { timeout: 3000 });
      const m = /Keying material:\s*([0-9A-F]+)/.exec(srv.out());
      expect(m).not.toBeNull();
      expect(m![1]).toBe(mine);
      expect(mine).toHaveLength(64);
      chan.close();
      sock.destroy();
    } finally {
      srv.kill();
    }
  });

  it("refuses a server that only offers TLS_CHACHA20_POLY1305_SHA256 (the client forces AES-GCM, fixed 16 byte overhead)", async () => {
    const srv = await run("TLS_CHACHA20_POLY1305_SHA256");
    try {
      const { chan, sock } = bridge(srv.port);
      await expect(chan.handshake).rejects.toThrow();
      chan.close();
      sock.destroy();
    } finally {
      srv.kill();
    }
  });
});

describe("TLS key log", () => {
  it("writes the TLS secrets in NSS format when keyLogEnabled is set (opt-in)", async () => {
    await startPlc();
    const before = new Set(readdirSync(process.cwd()).filter((f) => /^key_\d{8}_\d{6}\.log$/.test(f)));
    const orig = S7Client.prototype.sslActivate;
    const spy = vi.spyOn(S7Client.prototype, "sslActivate").mockImplementation(function (this: S7Client) {
      this.keyLogEnabled = true;
      return orig.call(this);
    });
    try {
      const conn = await connectOk();
      await conn.disconnect();
    } finally {
      spy.mockRestore();
    }
    const created = readdirSync(process.cwd()).filter((f) => /^key_\d{8}_\d{6}\.log$/.test(f) && !before.has(f));
    expect(created).toHaveLength(1);
    const txt = readFileSync(join(process.cwd(), created[0]), "utf8");
    rmSync(join(process.cwd(), created[0]));
    expect(txt).toMatch(/^CLIENT_HANDSHAKE_TRAFFIC_SECRET [0-9a-f]{64} [0-9a-f]+$/m);
    expect(txt).toMatch(/^CLIENT_TRAFFIC_SECRET_0 /m);
    expect(txt).toMatch(/^EXPORTER_SECRET /m);
  });

  it("writes no key log by default", async () => {
    await startPlc();
    const before = new Set(readdirSync(process.cwd()).filter((f) => f.startsWith("key_")));
    const conn = await connectOk();
    await conn.disconnect();
    expect(readdirSync(process.cwd()).filter((f) => f.startsWith("key_") && !before.has(f))).toEqual([]);
  });
});
