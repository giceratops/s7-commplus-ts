/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { ByteStream } from "../core/ByteStream.js";
import { S7p } from "../core/S7p.js";
import { ValueBlob } from "../core/PValue.js";
import { Utils } from "../core/Utils.js";

const NL = "\n";

//  7813 = DAI.HmiInfo
export class AlarmsHmiInfo {
  syntaxId = 0;
  version = 0;
  clientAlarmId = 0;
  priority = 0;
  reserved1 = 0;
  reserved2 = 0;
  reserved3 = 0;
  alarmClass = 0;
  producer = 0;
  groupId = 0;
  flags = 0;

  toString(): string {
    let s = "<AlarmsHmiInfo>" + NL;
    s += "<SyntaxId>" + this.syntaxId + "</SyntaxId>" + NL;
    s += "<Version>" + this.version + "</Version>" + NL;
    s += "<ClientAlarmId>" + this.clientAlarmId + "</ClientAlarmId>" + NL;
    s += "<Priority>" + this.priority + "</Priority>" + NL;
    if (this.syntaxId >= 257) {
      s += "<Reserved1>" + this.reserved1 + "</Reserved1>" + NL;
      s += "<Reserved2>" + this.reserved2 + "</Reserved2>" + NL;
      s += "<Reserved3>" + this.reserved3 + "</Reserved3>" + NL;
      if (this.syntaxId >= 258) {
        s += "<AlarmClass>" + this.alarmClass + "</AlarmClass>" + NL;
        s += "<Producer>" + this.producer + "</Producer>" + NL;
        s += "<GroupId>" + this.groupId + "</GroupId>" + NL;
        s += "<Flags>" + this.flags + "</Flags>" + NL;
      }
    }
    s += "</AlarmsHmiInfo>" + NL;
    return s;
  }

  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    this.syntaxId = S7p.decodeUInt16(buffer);
    this.version = S7p.decodeUInt16(buffer);
    this.clientAlarmId = S7p.decodeUInt32(buffer);
    this.priority = S7p.decodeByte(buffer);
    if (this.syntaxId >= 257) {
      this.reserved1 = S7p.decodeByte(buffer);
      this.reserved2 = S7p.decodeByte(buffer);
      this.reserved3 = S7p.decodeByte(buffer);
      if (this.syntaxId >= 258) {
        this.alarmClass = S7p.decodeUInt16(buffer);
        this.producer = S7p.decodeByte(buffer);
        this.groupId = S7p.decodeByte(buffer);
        this.flags = S7p.decodeByte(buffer);
      }
    }
    return buffer.position - start;
  }

  static fromValueBlob(blob: ValueBlob): AlarmsHmiInfo {
    const hmiinfo = new AlarmsHmiInfo();
    const barr = blob.getValue()!;
    let pos = 0;
    hmiinfo.syntaxId = Utils.getUInt16(barr, pos);
    pos += 2;
    hmiinfo.version = Utils.getUInt16(barr, pos);
    pos += 2;
    hmiinfo.clientAlarmId = Utils.getUInt32(barr, pos);
    pos += 4;
    hmiinfo.priority = Utils.getUInt8(barr, pos);
    pos += 1;
    if (hmiinfo.syntaxId >= 257) {
      hmiinfo.reserved1 = Utils.getUInt8(barr, pos);
      pos += 1;
      hmiinfo.reserved2 = Utils.getUInt8(barr, pos);
      pos += 1;
      hmiinfo.reserved3 = Utils.getUInt8(barr, pos);
      pos += 1;
      if (hmiinfo.syntaxId >= 258) {
        hmiinfo.alarmClass = Utils.getUInt16(barr, pos);
        pos += 2;
        hmiinfo.producer = Utils.getUInt8(barr, pos);
        pos += 1;
        hmiinfo.groupId = Utils.getUInt8(barr, pos);
        pos += 1;
        hmiinfo.flags = Utils.getUInt8(barr, pos);
        pos += 1;
      }
    }
    return hmiinfo;
  }
}
