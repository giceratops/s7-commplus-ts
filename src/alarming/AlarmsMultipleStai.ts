/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { ByteStream } from "../core/ByteStream.js";
import { S7p } from "../core/S7p.js";
import { AlarmsHmiInfo } from "./AlarmsHmiInfo.js";

const NL = "\n";

export class AlarmsMultipleStai {
  alid = 0;
  alarmDomain = 0; // 1=Systemdiagnose, 2=Security, 256..272 = UserClass_0..UserClass_16
  messageType = 0; // 1=Alarm AP, 2=Notify AP, 3=Info Report AP, 4=Event Ack AP
  alarmEnabled = 0; // 0=No, 1=Yes

  hmiInfoLength = 0;
  hmiInfo!: AlarmsHmiInfo;
  lidCount = 0;
  lids: number[] = [];

  toString(): string {
    let s = "";
    s += "<AlarmsMultipleStai>" + NL;
    s += "<Alid>" + this.alid + "</Alid>" + NL;
    s += "<AlarmDomain>" + this.alarmDomain + "</AlarmDomain>" + NL;
    s += "<MessageType>" + this.messageType + "</MessageType>" + NL;
    s += "<AlarmEnabled>" + this.alarmEnabled + "</AlarmEnabled>" + NL;
    s += "<HmiInfoLength>" + this.hmiInfoLength + "</HmiInfoLength>" + NL;
    s += "<HmiInfo>" + NL + this.hmiInfo.toString() + "</HmiInfo>" + NL;
    s += "<LidCount>" + this.lidCount + "</LidCount>" + NL;
    for (const li of this.lids) {
      s += "<Lid>" + li + "</Lid>" + NL;
    }
    s += "</AlarmsMultipleStai>" + NL;
    return s;
  }

  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    this.alid = S7p.decodeUInt16(buffer);
    this.alarmDomain = S7p.decodeUInt16(buffer);
    this.messageType = S7p.decodeUInt16(buffer);
    this.alarmEnabled = S7p.decodeByte(buffer);
    this.hmiInfoLength = S7p.decodeUInt16(buffer);
    this.hmiInfo = new AlarmsHmiInfo();
    this.hmiInfo.deserialize(buffer);
    this.lidCount = S7p.decodeUInt16(buffer);
    this.lids = new Array<number>(this.lidCount).fill(0);
    for (let i = 0; i < this.lidCount; i++) {
      this.lids[i] = S7p.decodeUInt32(buffer);
    }
    return buffer.position - start;
  }
}
