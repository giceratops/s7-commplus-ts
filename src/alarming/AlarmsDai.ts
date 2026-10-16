/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { Ids } from "../core/Ids.js";
import { PObject } from "../core/PObject.js";
import {
  ValueWString, ValueLWord, ValueUSInt, ValueUInt, ValueDInt, ValueBlob, ValueUDInt, ValueStruct, ValueBlobSparseArray,
} from "../core/PValue.js";
import { AlarmsAlarmTexts } from "./AlarmsAlarmTexts.js";
import { AlarmsAsCgs } from "./AlarmsAsCgs.js";
import { AlarmsHmiInfo } from "./AlarmsHmiInfo.js";

const NL = "\n";

export class AlarmsDai {
  objectVariableTypeName = "";

  cpuAlarmId = 0n;
  allStatesInfo = 0;
  alarmDomain = 0;
  messageType = 0;
  sequenceCounter = 0;
  alarmTexts: AlarmsAlarmTexts | null = null;
  hmiInfo!: AlarmsHmiInfo;
  asCgs!: AlarmsAsCgs;

  toString(): string {
    let s = "<AlarmsDai>" + NL;
    s += "<ObjectVariableTypeName>" + this.objectVariableTypeName + "</ObjectVariableTypeName>" + NL;
    s += "<CpuAlarmId>" + this.cpuAlarmId + "</CpuAlarmId>" + NL;
    s += "<AllStatesInfo>" + this.allStatesInfo + "</AllStatesInfo>" + NL;
    s += "<AlarmDomain>" + this.alarmDomain + "</AlarmDomain>" + NL;
    s += "<MessageType>" + this.messageType + "</MessageType>" + NL;
    s += "<HmiInfo>" + NL + this.hmiInfo.toString() + "</HmiInfo>" + NL;
    s += "<AsCgs>" + NL + this.asCgs.toString() + "</AsCgs>" + NL;
    s += "<SequenceCounter>" + this.sequenceCounter + "</SequenceCounter>" + NL;
    if (this.alarmTexts != null) {
      s += "<AlarmTexts>" + NL + this.alarmTexts.toString() + "</AlarmTexts>" + NL;
    } else {
      s += "<AlarmTexts></AlarmTexts>" + NL;
    }
    s += "</AlarmsDai>" + NL;
    return s;
  }

  /** Returns null if the object contains neither DAI.Coming nor DAI.Going (like the C# code). */
  static fromNotificationObject(pobj: PObject, alarmtextsLanguageId: number): AlarmsDai | null {
    const dai = new AlarmsDai();
    dai.objectVariableTypeName = (pobj.getAttribute(Ids.ObjectVariableTypeName) as ValueWString).getValue();
    dai.cpuAlarmId = (pobj.getAttribute(Ids.DAI_CPUAlarmID) as ValueLWord).getValue();
    dai.allStatesInfo = (pobj.getAttribute(Ids.DAI_AllStatesInfo) as ValueUSInt).getValue();
    dai.alarmDomain = (pobj.getAttribute(Ids.DAI_AlarmDomain) as ValueUInt).getValue();
    dai.messageType = (pobj.getAttribute(Ids.DAI_MessageType) as ValueDInt).getValue();
    dai.hmiInfo = AlarmsHmiInfo.fromValueBlob(pobj.getAttribute(Ids.DAI_HmiInfo) as ValueBlob);
    // TODO: Blob for additional values
    dai.sequenceCounter = (pobj.getAttribute(Ids.DAI_SequenceCounter) as ValueUDInt).getValue();
    let str: ValueStruct | null = null;
    let daiId = 0;
    if (pobj.attributes.has(Ids.DAI_Coming)) {
      str = pobj.getAttribute(Ids.DAI_Coming) as ValueStruct;
      daiId = Ids.DAI_Coming;
    } else if (pobj.attributes.has(Ids.DAI_Going)) {
      str = pobj.getAttribute(Ids.DAI_Going) as ValueStruct;
      daiId = Ids.DAI_Going;
    }
    if (daiId === 0 || str === null) {
      return null;
    }
    dai.asCgs = AlarmsAsCgs.fromValueStruct(str);
    dai.asCgs.subtypeId = daiId;
    dai.alarmTexts = AlarmsAlarmTexts.fromNotificationBlob(
      pobj.getAttribute(Ids.DAI_AlarmTexts_Rid) as ValueBlobSparseArray,
      alarmtextsLanguageId,
    );
    return dai;
  }
}
