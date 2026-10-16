/*
 * Integration tests of ExploreASAlarms / GetActiveAlarms (alarming/BrowseAlarms) and CommRessources.ReadMax / ReadFree
 * against the in-process mock PLC (alarm data: test/mock-plc/alarms.ts, layouts derived from the C# parsing code).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommRessources, Ids, PlcTagInt, S7CommPlusConnection, S7Consts, ValueDInt } from "../src/index.js";
import type { AlarmData } from "../src/index.js";
import { MockPlc } from "./mock-plc/MockPlc.js";
import type { MockPlcOptions } from "./mock-plc/MockPlc.js";
import { AS_ALARMS_REL, LANG_DE, LANG_EN, LANG_FR, cpuAlarmId, defaultAlarmModel } from "./mock-plc/alarms.js";

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

async function start(opts: Partial<MockPlcOptions> = {}): Promise<S7CommPlusConnection> {
  plc = new MockPlc({ fixedChallenge: true, ...opts });
  await plc.start();
  const c = new S7CommPlusConnection();
  c.plcPort = plc.port;
  conns.push(c);
  expect(await c.connect("127.0.0.1", "", "", 3000)).toBe(0);
  return c;
}

const alarmsOf = async (c: S7CommPlusConnection, lang: number): Promise<{ res: number; alarms: Map<bigint, AlarmData> }> => {
  const alarms = new Map<bigint, AlarmData>();
  const res = await c.exploreASAlarms(alarms, lang);
  return { res, alarms };
};

describe("ExploreASAlarms", () => {
  it("collects AS and program alarms and their texts in German", async () => {
    const c = await start();
    const { res, alarms } = await alarmsOf(c, LANG_DE);
    expect(res).toBe(0);
    // 2 AS alarms + 2 alarms of DB1 + 2 alarms of the Main FC
    expect([...alarms.keys()]).toEqual([
      cpuAlarmId(AS_ALARMS_REL, 1), cpuAlarmId(AS_ALARMS_REL, 2), cpuAlarmId(0x8a0e0001, 1), cpuAlarmId(0x8a0e0001, 2),
      cpuAlarmId(0x00010001, 7), cpuAlarmId(0x00010001, 8),
    ]);

    const as1 = alarms.get(cpuAlarmId(AS_ALARMS_REL, 1))!;
    expect(as1.relationId).toBe(AS_ALARMS_REL);
    expect(as1.multipleStai.alid).toBe(1);
    expect(as1.multipleStai.alarmDomain).toBe(1);
    expect(as1.multipleStai.messageType).toBe(1);
    expect(as1.multipleStai.alarmEnabled).toBe(1);
    expect(as1.multipleStai.hmiInfo).toMatchObject({
      syntaxId: 258, version: 1, clientAlarmId: 1001, priority: 5, alarmClass: 1, producer: 2, groupId: 0, flags: 0,
    });
    expect(as1.alText).toMatchObject({
      languageId: LANG_DE, infotext: "Systemdiagnose", alarmText: "Baugruppe fehlt oder defekt", additionalText1: "Steckplatz",
      additionalText2: "Rack", additionalText3: "", unknownValue1: 3, unknownValue2: 0,
    });

    const as2 = alarms.get(cpuAlarmId(AS_ALARMS_REL, 2))!;
    expect(as2.multipleStai.alarmEnabled).toBe(0);
    expect(as2.multipleStai.hmiInfo).toMatchObject({ syntaxId: 257, clientAlarmId: 1002, priority: 9, reserved1: 1, reserved2: 2, reserved3: 3 });
    expect(as2.multipleStai.lidCount).toBe(1);
    expect(as2.multipleStai.lids).toEqual([0x11]);

    // all 9 additional texts, umlauts (UTF-8 byte length != character count)
    const motor = alarms.get(cpuAlarmId(0x8a0e0001, 1))!;
    expect(motor.relationId).toBe(0x8a0e0001);
    expect(motor.multipleStai.lids).toEqual([0x10001, 0x10002, 0x10003]);
    expect(motor.multipleStai.hmiInfo).toMatchObject({ syntaxId: 258, version: 2, clientAlarmId: 2001, priority: 12, alarmClass: 3, producer: 4, groupId: 5, flags: 6 });
    expect(motor.alText.alarmText).toBe("Motor überlastet");
    expect(motor.alText.infotext).toBe("Hilfetext zur Motorstörung");
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (motor.alText as unknown as Record<string, string>)["additionalText" + i])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => "Zusatz " + i),
    );
    expect([motor.alText.unknownValue1, motor.alText.unknownValue2]).toEqual([1, 2]);

    // HmiInfo syntax 256 has neither the reserved bytes nor the class fields
    const level = alarms.get(cpuAlarmId(0x8a0e0001, 2))!;
    expect(level.multipleStai.hmiInfo).toMatchObject({ syntaxId: 256, clientAlarmId: 2002, priority: 1, reserved1: 0, alarmClass: 0 });
    expect(level.alText).toMatchObject({ alarmText: "Füllstand niedrig", additionalText1: "Tank 1", infotext: "" });

    // an alarm without texts keeps the defaults, and the language id is only set for alarms that have a text entry
    const cyl = alarms.get(cpuAlarmId(0x00010001, 8))!;
    expect(cyl.alText.languageId).toBe(0);
    expect(cyl.alText.alarmText).toBe("");
    expect(alarms.get(cpuAlarmId(0x00010001, 7))!.alText.alarmText).toBe("Zylinder klemmt");
    expect(alarms.has(cpuAlarmId(0x8a0e0009, 4))).toBe(false); // text without definition is skipped
    expect(plc.violations).toEqual([]);

    // the dump
    const dump = motor.toString();
    expect(dump).toContain("<AlarmText>Motor überlastet</AlarmText>");
    expect(dump).toContain("<Lid>65538</Lid>");
    expect(dump).toContain(`<CpuAlarmId>${cpuAlarmId(0x8a0e0001, 1)}</CpuAlarmId>`);
  });

  it("returns the texts of the requested language, several languages can be read one after the other", async () => {
    const c = await start();
    const en = (await alarmsOf(c, LANG_EN)).alarms;
    expect(en.get(cpuAlarmId(0x8a0e0001, 1))!.alText).toMatchObject({ languageId: LANG_EN, alarmText: "Motor overload", additionalText9: "Add 9" });
    expect(en.get(cpuAlarmId(0x00010001, 7))!.alText.alarmText).toBe(""); // no English text defined
    const fr = (await alarmsOf(c, LANG_FR)).alarms;
    expect(fr.get(cpuAlarmId(0x8a0e0001, 1))!.alText).toMatchObject({ languageId: LANG_FR, alarmText: "Moteur en surcharge", infotext: "" });
    expect(fr.get(cpuAlarmId(AS_ALARMS_REL, 1))!.alText.languageId).toBe(0);
    // the request ids: 0x8A360000 + language
    const ids = plc.requests.filter((r) => r.kind === "Explore").map((r) => (r as { exploreId: number }).exploreId);
    expect(ids).toEqual([AS_ALARMS_REL, Ids.NativeObjects_thePLCProgram_Rid, 0x8a360000 + LANG_EN, AS_ALARMS_REL, Ids.NativeObjects_thePLCProgram_Rid, 0x8a360000 + LANG_FR]);
    expect(plc.violations).toEqual([]);
  });

  it("masks the language id with 0xFFFF for the text library id", async () => {
    const c = await start();
    const { res } = await alarmsOf(c, 0x10000 + LANG_DE);
    expect(res).toBe(0);
  });

  it("an unknown language is reported as errIsoInvalidPDU (the alarms found so far stay in the dictionary)", async () => {
    const c = await start();
    const { res, alarms } = await alarmsOf(c, 1040);
    expect(res).toBe(S7Consts.errIsoInvalidPDU);
    expect(alarms.size).toBe(6);
    expect(alarms.get(cpuAlarmId(0x8a0e0001, 1))!.alText.alarmText).toBe("");
  });

  it("exploring twice into the same dictionary throws (Dictionary.Add of the C# code) and releases the request lock", async () => {
    const c = await start();
    const alarms = new Map<bigint, AlarmData>();
    expect(await c.exploreASAlarms(alarms, LANG_DE)).toBe(0);
    await expect(c.exploreASAlarms(alarms, LANG_DE)).rejects.toThrow(/same key/);
    const t = (await c.getPlcTagBySymbol("TestDB.counter")) as PlcTagInt;
    expect(await c.readTags([t])).toBe(0);
  });

  it("works without alarms and with an empty text library", async () => {
    const c = await start({ alarmModel: { ...defaultAlarmModel(), stais: [], orphanTexts: [], blocksWithoutAlarms: [] } });
    // no MultipleSTAI object below 0x8A7E0000 exists with texts, but the AS object always has the (empty) STAI array
    const { res, alarms } = await alarmsOf(c, LANG_DE);
    expect(res).toBe(0);
    expect(alarms.size).toBe(0);
  });

  it("logs and skips MultipleSTAI attributes that are no BlobSparseArray", async () => {
    const c = await start({ alarmModel: { ...defaultAlarmModel(), userStaisAsPlainBlob: true } });
    const { res, alarms } = await alarmsOf(c, LANG_DE);
    expect(res).toBe(0);
    expect(alarms.size).toBe(2); // only the AS alarms
    expect(logs.filter((l) => l.includes("stais is not ValueBlobSparseArray"))).toHaveLength(2);
  });

  it("returns the error code of failing explores: error response (all three steps), no answer", async () => {
    let n = 0;
    const c = await start({
      onRequest: (r) => (r.kind === "Explore" && ++n === 1 ? { error: true } : r.kind === "Explore" && n === 3 ? { error: true } : r.kind === "Explore" && n === 6 ? { error: true } : undefined),
    });
    expect((await alarmsOf(c, LANG_DE)).res).toBe(S7Consts.errIsoInvalidPDU); // 1: ASAlarms
    expect((await alarmsOf(c, LANG_DE)).res).toBe(S7Consts.errIsoInvalidPDU); // 2 ok, 3: program
    expect((await alarmsOf(c, LANG_DE)).res).toBe(S7Consts.errIsoInvalidPDU); // 4, 5 ok, 6: texts
    expect((await alarmsOf(c, LANG_DE)).res).toBe(0);
  });

  it("times out when the PLC does not answer", async () => {
    const c = await start({ onRequest: (r) => (r.kind === "Explore" && r.exploreId === AS_ALARMS_REL ? { drop: true } : undefined) });
    c.readTimeout = 300;
    expect((await alarmsOf(c, LANG_DE)).res).toBe(S7Consts.errTCPDataReceive);
  });
});

describe("GetActiveAlarms", () => {
  it("returns several active alarms with texts of the requested language", async () => {
    const c = await start();
    const { res, alarmList } = await c.getActiveAlarms(LANG_DE);
    expect(res).toBe(0);
    expect(alarmList).toHaveLength(3);
    const [motor, module, cyl] = alarmList;

    expect(motor.objectVariableTypeName).toBe("DAI_Motor");
    expect(motor.cpuAlarmId).toBe(cpuAlarmId(0x8a0e0001, 1));
    expect(motor.allStatesInfo).toBe(5);
    expect(motor.alarmDomain).toBe(256);
    expect(motor.messageType).toBe(1);
    expect(motor.sequenceCounter).toBe(41);
    expect(motor.hmiInfo).toMatchObject({ syntaxId: 258, version: 2, clientAlarmId: 2001, priority: 12, alarmClass: 3, producer: 4, groupId: 5, flags: 6 });
    expect(motor.alarmTexts).toMatchObject({ languageId: LANG_DE, alarmText: "Motor überlastet", infotext: "Hilfetext zur Motorstörung", additionalText1: "Zusatz 1", additionalText2: "Zusatz 2", additionalText3: "" });
    expect(motor.asCgs.subtypeId).toBe(Ids.DAI_Coming);
    expect(motor.asCgs.allStatesInfo).toBe(1);
    expect(motor.asCgs.timestamp.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(motor.asCgs.ackTimestamp.getTime()).toBe(0);
    const av = motor.asCgs.associatedValues;
    expect([av.SD_1, av.SD_2, av.SD_3, av.SD_4, av.SD_5, av.SD_6, av.SD_7, av.SD_8, av.SD_9, av.SD_10].map((v) => v?.toString())).toEqual([
      "-2", "256", "True", "hello", "3.5", "AB€", "4294967295", "-10", "4660", "1.5",
    ]);

    // going alarm without a German text
    expect(module.cpuAlarmId).toBe(cpuAlarmId(AS_ALARMS_REL, 1));
    expect(module.asCgs.subtypeId).toBe(Ids.DAI_Going);
    expect(module.asCgs.ackTimestamp.toISOString()).toBe("2023-11-14T22:13:29.000Z");
    expect(module.alarmTexts).toMatchObject({ languageId: LANG_DE, alarmText: "", infotext: "" });
    const av2 = module.asCgs.associatedValues;
    expect([av2.SD_1, av2.SD_2, av2.SD_3, av2.SD_4, av2.SD_5].map((v) => v?.toString())).toEqual(["127", "X", "Y", "65534", "3735928559"]);

    expect(cyl.alarmTexts!.alarmText).toBe("Zylinder klemmt");
    expect(plc.violations).toEqual([]);

    const req = plc.requests.find((r) => r.kind === "Explore")! as { exploreId: number; exploreRequestId: number; recursive: number; attributes: number[] };
    expect(req.exploreId).toBe(Ids.NativeObjects_theAlarmSubsystem_Rid);
    expect(req.exploreRequestId).toBe(Ids.AlarmSubsystem_itsUpdateRelevantDAI);
    expect(req.recursive).toBe(1);
    expect(req.attributes).toEqual([
      Ids.DAI_CPUAlarmID, Ids.DAI_AllStatesInfo, Ids.DAI_AlarmDomain, Ids.DAI_Coming, Ids.DAI_Going, Ids.DAI_MessageType, Ids.DAI_HmiInfo,
      Ids.ObjectVariableTypeName, Ids.DAI_SequenceCounter, Ids.DAI_AlarmTexts_Rid,
    ]);
  });

  it("texts follow the language id", async () => {
    const c = await start();
    const en = (await c.getActiveAlarms(LANG_EN)).alarmList;
    expect(en.map((a) => a.alarmTexts!.alarmText)).toEqual(["Motor overload", "Module missing or defective", ""]);
    const fr = (await c.getActiveAlarms(LANG_FR)).alarmList;
    expect(fr.map((a) => a.alarmTexts!.alarmText)).toEqual(["", "", "Vérin bloqué"]);
    const none = (await c.getActiveAlarms(1040)).alarmList;
    expect(none.map((a) => a.alarmTexts!.alarmText)).toEqual(["", "", ""]);
  });

  it("returns an empty list when no alarm is active", async () => {
    const c = await start({ alarmModel: { ...defaultAlarmModel(), active: [] } });
    const { res, alarmList } = await c.getActiveAlarms(LANG_DE);
    expect(res).toBe(0);
    expect(alarmList).toEqual([]);
  });

  it("an object without DAI.Coming / DAI.Going becomes null in the list (like in the C# code)", async () => {
    const c = await start({ alarmModel: { ...defaultAlarmModel(), oddActive: true } });
    const { res, alarmList } = await c.getActiveAlarms(LANG_DE);
    expect(res).toBe(0);
    expect(alarmList.map((a) => a && a.objectVariableTypeName)).toEqual(["DAI_Motor", null, "DAI_Module", "DAI_Cylinder"]);
  });

  it("throws like the C# KeyNotFoundException when a requested attribute is missing, and stays usable", async () => {
    const c = await start({ alarmModel: { ...defaultAlarmModel(), omitActiveAttributes: [Ids.DAI_AlarmTexts_Rid] } });
    await expect(c.getActiveAlarms(LANG_DE)).rejects.toThrow(/not present/);
    const t = (await c.getPlcTagBySymbol("TestDB.counter")) as PlcTagInt;
    expect(await c.readTags([t])).toBe(0);
  });

  it("error response and wrong answers are reported as errIsoInvalidPDU", async () => {
    const c = await start({ onRequest: (r) => (r.kind === "Explore" ? { error: true } : undefined) });
    expect((await c.getActiveAlarms(LANG_DE)).res).toBe(S7Consts.errIsoInvalidPDU);
  });

  it("works while an alarm subscription exists", async () => {
    const c = await start();
    expect(await c.alarmSubscriptionCreate()).toBe(0);
    expect((await c.getActiveAlarms(LANG_DE)).alarmList).toHaveLength(3);
    expect(await c.alarmSubscriptionDelete()).toBe(0);
  });
});

describe("CommRessources", () => {
  it("ReadMax runs during connect and fills the limits", async () => {
    const c = await start({ tagsPerReadRequestMax: 7, tagsPerWriteRequestMax: 5 });
    const cr = c.commResources;
    expect(cr.tagsPerReadRequestMax).toBe(7);
    expect(cr.tagsPerWriteRequestMax).toBe(5);
    expect(cr.plcSubscriptionsMax).toBe(32);
    expect(cr.plcAttributesMax).toBe(10000);
    expect(cr.subscriptionMemoryMax).toBe(65536);
    // Free values are not read by the connection
    expect(cr.plcSubscriptionsFree).toBe(0);
    expect(cr.plcAttributesFree).toBe(0);
    expect(cr.subscriptionMemoryFree).toBe(0);
    const reads = plc.requests.filter((r) => r.kind === "GetMultiVariables") as Array<{ addresses: Array<{ accessArea: number; accessSubArea: number; lid: number[] }> }>;
    expect(reads[0].addresses.map((a) => [a.accessArea, a.accessSubArea, a.lid])).toEqual([
      [Ids.ObjectRoot, Ids.SystemLimits, [1000]], [Ids.ObjectRoot, Ids.SystemLimits, [1001]], [Ids.ObjectRoot, Ids.SystemLimits, [0]],
      [Ids.ObjectRoot, Ids.SystemLimits, [1]], [Ids.ObjectRoot, Ids.SystemLimits, [2]],
    ]);
    expect(plc.violations).toEqual([]);
  });

  it("ReadFree reads FreeItems and reflects active subscriptions", async () => {
    const c = await start();
    const cr = c.commResources;
    expect(await cr.readFree(c)).toBe(0);
    expect([cr.plcSubscriptionsFree, cr.plcAttributesFree, cr.subscriptionMemoryFree]).toEqual([32, 10000, 65536]);

    const t1 = (await c.getPlcTagBySymbol("TestDB.counter")) as PlcTagInt;
    const t2 = (await c.getPlcTagBySymbol("TestDB.samples[1]")) as PlcTagInt;
    expect(await c.subscriptionCreate([t1, t2], 100)).toBe(0);
    expect(await c.testWaitForVariableChangeNotifications(1)).toBe(0);
    expect(await cr.readFree(c)).toBe(0);
    expect([cr.plcSubscriptionsFree, cr.plcAttributesFree, cr.subscriptionMemoryFree]).toEqual([31, 9998, 65536 - 256 - 128]);
    expect(await c.subscriptionDelete()).toBe(0);
    expect(await cr.readFree(c)).toBe(0);
    expect([cr.plcSubscriptionsFree, cr.plcAttributesFree, cr.subscriptionMemoryFree]).toEqual([32, 10000, 65536]);

    const last = plc.requests.filter((r) => r.kind === "GetMultiVariables").pop() as { addresses: Array<{ accessArea: number; accessSubArea: number; lid: number[] }> };
    expect(last.addresses.map((a) => [a.accessArea, a.accessSubArea, a.lid])).toEqual([
      [Ids.ObjectRoot, Ids.FreeItems, [0]], [Ids.ObjectRoot, Ids.FreeItems, [1]], [Ids.ObjectRoot, Ids.FreeItems, [2]],
    ]);
    expect(cr.toString()).toContain("<PlcSubscriptionsFree>32</PlcSubscriptionsFree>");
    expect(plc.violations).toEqual([]);
  });

  it("items with an error keep their previous value (ReadValues reports per-item errors in the error list, not in the result)", async () => {
    const c = await start({ freeItemsError: [1] });
    const cr = c.commResources;
    cr.plcAttributesFree = 123;
    const res = await cr.readFree(c);
    expect(res).toBe(0);
    expect(cr.plcSubscriptionsFree).toBe(32);
    expect(cr.plcAttributesFree).toBe(123);
    expect(cr.subscriptionMemoryFree).toBe(65536);
  });

  it("a stand-alone instance can read from a connection", async () => {
    const c = await start();
    const cr = new CommRessources();
    expect(cr.tagsPerReadRequestMax).toBe(20);
    expect(await cr.readMax(c)).toBe(0);
    expect(cr.plcSubscriptionsMax).toBe(32);
  });

  it("a value of another type than DInt throws (InvalidCastException in C#)", async () => {
    const c = await start({ freeItemsWrongType: true });
    await expect(c.commResources.readFree(c)).rejects.toThrow(/DInt/);
    expect(new ValueDInt(1).getValue()).toBe(1);
  });

  it("limits from the PLC drive the chunking of reads", async () => {
    const c = await start({ tagsPerReadRequestMax: 2 });
    const t = await Promise.all(["TestDB.counter", "TestDB.samples[1]", "TestDB.samples[2]", "TestDB.samples[3]", "TestDB.samples[0]"].map((s) => c.getPlcTagBySymbol(s)));
    expect(await c.readTags(t)).toBe(0);
    expect(plc.violations).toEqual([]);
  });
});
