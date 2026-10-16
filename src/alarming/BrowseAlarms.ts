/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { dictAdd } from "../core/NetCompat.js";
import { ByteStream } from "../core/ByteStream.js";
import { Ids } from "../core/Ids.js";
import { ProtocolVersion } from "../core/ProtocolVersion.js";
import { ExploreRequest } from "../core/ExploreRequest.js";
import { ExploreResponse } from "../core/ExploreResponse.js";
import type { PObject } from "../core/PObject.js";
import { ValueBlob, ValueBlobArray, ValueBlobSparseArray } from "../core/PValue.js";
import type { PValue } from "../core/PValue.js";
import { Utils } from "../core/Utils.js";
import { S7Consts } from "../net/S7Consts.js";
import type { S7CommPlusConnection } from "../S7CommPlusConnection.js";
import { AlarmsAlarmTexts } from "./AlarmsAlarmTexts.js";
import { AlarmsDai } from "./AlarmsDai.js";
import { AlarmsMultipleStai } from "./AlarmsMultipleStai.js";

const NL = "\n";

/**
 * The C# alarm helpers are part of the partial class S7CommPlusConnection and use its internal members.
 * This describes the (camelCase) members of the connection they rely on.
 */
export interface AlarmConnection {
  readonly sessionId2: number;
  readTimeout: number;
  lastError: number;
  receivedPDU: ByteStream;
  client: { disconnect(): void };
  sendS7plusFunctionObject(obj: unknown): Promise<number>;
  waitForNewS7plusReceived(timeout: number): Promise<void>;
  checkResponseWithIntegrity(req: unknown, res: unknown): number;
  subscriptionSetCreditLimit(limit: number): Promise<number>;
  deleteObject(objectId: number): Promise<number>;
}

/** Cast helper: the real connection class provides these members. */
export function asAlarmConnection(conn: S7CommPlusConnection): AlarmConnection {
  return conn as unknown as AlarmConnection;
}

function first<T>(arr: T[], pred: (o: T) => boolean): T {
  const r = arr.find(pred);
  if (r === undefined) throw new Error("Sequence contains no matching element");
  return r;
}

/**
 * Explores the AS and the User program alarms, gets the corresponding texts usind the language id (e.g.1031 = de-DE)
 *
 * @param alarms Map where the results are written to. Key is used as address.
 * @param languageId Language id for retrieving the text entries, use language code e.g. 1031 for german
 */
export async function exploreASAlarms(
  conn: AlarmConnection,
  alarms: Map<bigint, AlarmData>,
  languageId: number,
): Promise<number> {
  let res: number;

  // Explore all other than Alarm AP (AnwenderProgramAlarme)
  let exploreReq = new ExploreRequest(ProtocolVersion.V2);
  exploreReq.exploreId = 0x8a7e0000; // ASAlarms.0
  exploreReq.exploreRequestId = Ids.None;
  exploreReq.exploreChildsRecursive = 1;
  exploreReq.exploreParents = 0;

  res = await conn.sendS7plusFunctionObject(exploreReq);
  if (res !== 0) {
    return res;
  }
  conn.lastError = 0;
  await conn.waitForNewS7plusReceived(conn.readTimeout);
  if (conn.lastError !== 0) {
    return conn.lastError;
  }

  let exploreRes = ExploreResponse.deserializeFromPdu(conn.receivedPDU, true);
  res = conn.checkResponseWithIntegrity(exploreReq, exploreRes);
  if (res !== 0) {
    return res;
  }

  const alarmobjs = first(exploreRes!.objects, (o) => o.relationId === 0x8a7e0000).getObjects();
  const staiclass = first(alarmobjs, (o) => o.classId === Ids.MultipleSTAI_Class_Rid);

  if (staiclass != null) {
    const stais: PValue | null | undefined = staiclass.getAttribute(Ids.MultipleSTAI_STAIs);
    if (stais != null) {
      if (stais instanceof ValueBlobSparseArray) {
        const dict = stais.getValue();
        for (const [, entry] of dict) {
          const alarm = new AlarmData(0x8a7e0000); // TODO: Get this from parent object?
          const buffer = new ByteStream(entry.value!);
          alarm.deserialize(buffer);
          dictAdd(alarms, alarm.getCpuAlarmId(), alarm);
        }
      } else {
        console.log("ExploreASAlarms(): stais is not ValueBlobSparseArray");
      }
    } else {
      console.log("ExploreASAlarms(): stais = null");
    }
  } else {
    console.log("ExploreASAlarms(): staiclass = null");
  }

  // Explore Alarm AP
  exploreReq = new ExploreRequest(ProtocolVersion.V2);
  exploreReq.exploreId = Ids.NativeObjects_thePLCProgram_Rid;
  exploreReq.exploreRequestId = Ids.None;
  exploreReq.exploreChildsRecursive = 1;
  exploreReq.exploreParents = 0;

  // Add the requestes attributes
  exploreReq.addressList.push(Ids.ObjectVariableTypeParentObject);
  exploreReq.addressList.push(Ids.MultipleSTAI_STAIs);

  res = await conn.sendS7plusFunctionObject(exploreReq);
  if (res !== 0) {
    return res;
  }
  conn.lastError = 0;
  await conn.waitForNewS7plusReceived(conn.readTimeout);
  if (conn.lastError !== 0) {
    return conn.lastError;
  }

  exploreRes = ExploreResponse.deserializeFromPdu(conn.receivedPDU, true);
  if (exploreRes == null || exploreRes.sequenceNumber !== exploreReq.sequenceNumber || exploreRes.returnValue !== 0n) {
    return S7Consts.errIsoInvalidPDU;
  }

  // All objects which have Alarm AP inside, have a sub-Object with ID 7854 = MultipleSTAI.Class_Rid
  const obj = first(exploreRes.objects, (o) => o.classId === Ids.PLCProgram_Class_Rid);

  for (const ob of obj.getObjects()) {
    const staiclasses = ob.getObjectsByClassId(Ids.MultipleSTAI_Class_Rid);
    if (staiclasses != null && staiclasses.length > 0) {
      const stais: PValue | null | undefined = staiclasses[0].getAttribute(Ids.MultipleSTAI_STAIs);
      if (stais != null) {
        if (stais instanceof ValueBlobSparseArray) {
          const dict = stais.getValue();
          for (const [, entry] of dict) {
            const alarm = new AlarmData(ob.relationId);
            const buffer = new ByteStream(entry.value!);

            alarm.deserialize(buffer);
            dictAdd(alarms, alarm.getCpuAlarmId(), alarm);
          }
        } else {
          console.log("ExploreASAlarms(): stais is not ValueBlobSparseArray");
        }
      } else {
        console.log("ExploreASAlarms(): stais = null");
      }
    }
  }

  // Explore AlarmTextLists
  exploreReq = new ExploreRequest(ProtocolVersion.V2);
  exploreReq.exploreId = (0x8a360000 + (languageId & 0xffff)) >>> 0; // There may be several languages, add language ID (e.g. 1031 = german / de-DE)
  exploreReq.exploreRequestId = Ids.None;
  exploreReq.exploreChildsRecursive = 0;
  exploreReq.exploreParents = 0;

  res = await conn.sendS7plusFunctionObject(exploreReq);
  if (res !== 0) {
    return res;
  }
  conn.lastError = 0;
  await conn.waitForNewS7plusReceived(conn.readTimeout);
  if (conn.lastError !== 0) {
    return conn.lastError;
  }

  exploreRes = ExploreResponse.deserializeFromPdu(conn.receivedPDU, true);
  if (exploreRes == null || exploreRes.sequenceNumber !== exploreReq.sequenceNumber || exploreRes.returnValue !== 0n) {
    return S7Consts.errIsoInvalidPDU;
  }

  // TextLibraryOffsetArea is an array[3] of Blob, which contains offset information.
  // [0] contains informations of how to get infos from [1], which has infos about offsets in [2].
  // [2] contains the resulting offsets for the strings in TextLibraryStringArea.
  // TODO: Check if all fields are present, or use try/catch?
  const textlib = first(exploreRes.objects, (o) => o.classId === Ids.TextLibraryClassRID);
  const tloa: ValueBlob[] = (textlib.getAttribute(Ids.TextLibraryOffsetArea) as ValueBlobArray).getValue();
  const tlsa: Uint8Array = (textlib.getAttribute(Ids.TextLibraryStringArea) as ValueBlob).getValue()!;

  const tloa1 = tloa[0].getValue()!;
  const tloa2 = tloa[1].getValue()!;
  const tloa3 = tloa[2].getValue()!;

  getTexts(tloa1, tloa2, tloa3, tlsa, alarms, languageId);

  return 0;
}

function getTexts(
  tloa1: Uint8Array,
  tloa2: Uint8Array,
  tloa3: Uint8Array,
  tlsa: Uint8Array,
  alarms: Map<bigint, AlarmData>,
  languageId: number,
): void {
  // Step 1: Get RelationId from table 1
  let pos1 = 16; // What is in the bytes before 16 is not known.

  const t1Count = Utils.getUInt32LE(tloa1, pos1);
  pos1 += 4;

  for (let i = 0; i < t1Count; i++) {
    const t1Relid = Utils.getUInt32LE(tloa1, pos1);
    pos1 += 4;
    const t1RelidOff = Utils.getUInt32LE(tloa1, pos1);
    pos1 += 4;

    // Step 2: Start offset in table 3
    let pos2 = t1RelidOff;
    const t2Count = Utils.getUInt32LE(tloa2, pos2);
    pos2 += 4;
    for (let j = 0; j < t2Count; j++) {
      const t2Alid = Utils.getUInt16LE(tloa2, pos2);
      pos2 += 2;
      const t2Off = Utils.getUInt32LE(tloa2, pos2);
      pos2 += 4;
      // This ID is used as unique identifier (address), which is also transferred later on alarm notification
      const cpualarmid = (BigInt(t1Relid) << 32n) | (BigInt(t2Alid) << 16n);

      // Check if we have the key stored from response data before, to have storage where we can put the Text information in
      const alarm = alarms.get(cpualarmid);
      if (alarm === undefined) {
        console.debug("BrowseAlarms GetTexts(): CPU Alarm Id " + cpualarmid.toString(16).toUpperCase() + " is not in dictionary!");
        continue;
      }
      alarm.alText.languageId = languageId;

      // Step 3: Get offsets to text array from table 3
      let pos3 = t2Off;
      const t3Count = Utils.getUInt32LE(tloa3, pos3);
      pos3 += 4;
      for (let k = 0; k < t3Count; k++) {
        // t3_typeindex:
        // 0 = Infotext, 1 = AlarmText, 2..10 = AdditionalText1..AdditionalText9, 255 = Unknown 1 or 2 values
        const t3Typeindex = Utils.getUInt8(tloa3, pos3);
        pos3 += 1;
        const t3Off = Utils.getUInt32LE(tloa3, pos3);
        pos3 += 4;

        // Step 4: Finally get the text and store the data
        if (t3Typeindex === 255) {
          alarm.alText.unknownValue1 = Utils.getUInt16LE(tlsa, t3Off);
          alarm.alText.unknownValue2 = Utils.getUInt16LE(tlsa, t3Off + 2);
        } else {
          const tsLen = Utils.getUInt16LE(tlsa, t3Off);
          const tsS = Utils.getUtfString(tlsa, t3Off + 2, tsLen);
          switch (t3Typeindex) {
            case 0: alarm.alText.infotext = tsS; break;
            case 1: alarm.alText.alarmText = tsS; break;
            case 2: alarm.alText.additionalText1 = tsS; break;
            case 3: alarm.alText.additionalText2 = tsS; break;
            case 4: alarm.alText.additionalText3 = tsS; break;
            case 5: alarm.alText.additionalText4 = tsS; break;
            case 6: alarm.alText.additionalText5 = tsS; break;
            case 7: alarm.alText.additionalText6 = tsS; break;
            case 8: alarm.alText.additionalText7 = tsS; break;
            case 9: alarm.alText.additionalText8 = tsS; break;
            case 10: alarm.alText.additionalText9 = tsS; break;
          }
        }
      }
    }
  }
}

/**
 * Reads the active program alarms from the Plc (single poll).
 *
 * @param languageId Language id for retrieving the text entries, use language code e.g. 1031 for german
 * @returns res: 0 on success; alarmList: the alarms, empty if there is no active alarm
 */
export async function getActiveAlarms(
  conn: AlarmConnection,
  languageId: number,
): Promise<{ res: number; alarmList: AlarmsDai[] }> {
  const alarmList: AlarmsDai[] = [];

  const exploreReq = new ExploreRequest(ProtocolVersion.V2);
  exploreReq.exploreId = Ids.NativeObjects_theAlarmSubsystem_Rid;
  exploreReq.exploreRequestId = Ids.AlarmSubsystem_itsUpdateRelevantDAI;
  exploreReq.exploreChildsRecursive = 1;
  exploreReq.exploreParents = 0;

  // Add the requestes attributes.
  // Request the same attributes we get from an alarm notification, so we can reuse other methods.
  exploreReq.addressList.push(Ids.DAI_CPUAlarmID);
  exploreReq.addressList.push(Ids.DAI_AllStatesInfo);
  exploreReq.addressList.push(Ids.DAI_AlarmDomain);
  exploreReq.addressList.push(Ids.DAI_Coming);
  exploreReq.addressList.push(Ids.DAI_Going);
  exploreReq.addressList.push(Ids.DAI_MessageType);
  exploreReq.addressList.push(Ids.DAI_HmiInfo);
  // Extra ones which we only need for compatibility with notification.
  exploreReq.addressList.push(Ids.ObjectVariableTypeName);
  exploreReq.addressList.push(Ids.DAI_SequenceCounter);
  exploreReq.addressList.push(Ids.DAI_AlarmTexts_Rid);

  let res = await conn.sendS7plusFunctionObject(exploreReq);
  if (res !== 0) {
    return { res, alarmList };
  }
  conn.lastError = 0;
  await conn.waitForNewS7plusReceived(conn.readTimeout);
  if (conn.lastError !== 0) {
    return { res: conn.lastError, alarmList };
  }

  const exploreRes = ExploreResponse.deserializeFromPdu(conn.receivedPDU, true);
  res = conn.checkResponseWithIntegrity(exploreReq, exploreRes);
  if (res !== 0) {
    return { res, alarmList };
  }

  for (const obj of exploreRes!.objects as PObject[]) {
    // C# adds the result as is (it may be null)
    alarmList.push(AlarmsDai.fromNotificationObject(obj, languageId) as AlarmsDai);
  }

  return { res: 0, alarmList };
}

export class AlarmData {
  relationId: number;

  multipleStai!: AlarmsMultipleStai;
  alText: AlarmsAlarmTexts = new AlarmsAlarmTexts();

  constructor(relationid: number) {
    this.relationId = relationid;
  }

  getCpuAlarmId(): bigint {
    return (BigInt(this.relationId) << 32n) | (BigInt(this.multipleStai.alid) << 16n);
  }

  deserialize(buffer: ByteStream): number {
    this.multipleStai = new AlarmsMultipleStai();
    return this.multipleStai.deserialize(buffer);
  }

  toString(): string {
    let s = "";
    s += "<AlarmData>" + NL;
    s += "<CpuAlarmId>" + this.getCpuAlarmId().toString() + "</CpuAlarmId>" + NL;
    s += "<RelationId>" + this.relationId + NL + "</RelationId>" + NL;
    s += "<MultipleStai>" + NL + this.multipleStai.toString() + "</MultipleStai>" + NL;
    s += "<AlText>" + NL;
    const t = this.alText;
    s += "<Infotext>" + t.infotext + "</Infotext>" + NL;
    s += "<AlarmText>" + t.alarmText + "</AlarmText>" + NL;
    s += "<AdditionalText1>" + t.additionalText1 + "</AdditionalText1>" + NL;
    s += "<AdditionalText2>" + t.additionalText2 + "</AdditionalText2>" + NL;
    s += "<AdditionalText3>" + t.additionalText3 + "</AdditionalText3>" + NL;
    s += "<AdditionalText4>" + t.additionalText4 + "</AdditionalText4>" + NL;
    s += "<AdditionalText5>" + t.additionalText5 + "</AdditionalText5>" + NL;
    s += "<AdditionalText6>" + t.additionalText6 + "</AdditionalText6>" + NL;
    s += "<AdditionalText7>" + t.additionalText7 + "</AdditionalText7>" + NL;
    s += "<AdditionalText8>" + t.additionalText8 + "</AdditionalText8>" + NL;
    s += "<AdditionalText9>" + t.additionalText9 + "</AdditionalText9>" + NL;
    s += "<UnknownValue1>" + t.unknownValue1 + "</UnknownValue1>" + NL;
    s += "<UnknownValue2>" + t.unknownValue2 + "</UnknownValue2>" + NL;
    s += "</AlText>" + NL;
    s += "</AlarmData>" + NL;
    return s;
  }
}
