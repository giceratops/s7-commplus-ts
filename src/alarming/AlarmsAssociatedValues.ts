/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { Ids } from "../core/Ids.js";
import { ValueBlobArray } from "../core/PValue.js";
import { Utils } from "../core/Utils.js";

const NL = "\n";

/** ISO-8859-1 decoding (Encoding.GetEncoding("ISO-8859-1")). */
function latin1(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** UTF-16 big endian decoding (Encoding.BigEndianUnicode). */
function utf16be(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  const end = Math.min(start + len, bytes.length);
  for (let i = start; i + 1 < end; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

export class AlarmsAssociatedValues {
  SD_1?: AssociatedValue;
  SD_2?: AssociatedValue;
  SD_3?: AssociatedValue;
  SD_4?: AssociatedValue;
  SD_5?: AssociatedValue;
  SD_6?: AssociatedValue;
  SD_7?: AssociatedValue;
  SD_8?: AssociatedValue;
  SD_9?: AssociatedValue;
  SD_10?: AssociatedValue;

  toString(): string {
    const f = (v?: AssociatedValue): string => (v === undefined ? "" : v.toString());
    let s = "<AlarmsAssociatedValues>" + NL;
    s += "<SD_1>" + f(this.SD_1) + "</SD_1>" + NL;
    s += "<SD_2>" + f(this.SD_2) + "</SD_2>" + NL;
    s += "<SD_3>" + f(this.SD_3) + "</SD_3>" + NL;
    s += "<SD_4>" + f(this.SD_4) + "</SD_4>" + NL;
    s += "<SD_5>" + f(this.SD_5) + "</SD_5>" + NL;
    s += "<SD_6>" + f(this.SD_6) + "</SD_6>" + NL;
    s += "<SD_7>" + f(this.SD_7) + "</SD_7>" + NL;
    s += "<SD_8>" + f(this.SD_8) + "</SD_8>" + NL;
    s += "<SD_9>" + f(this.SD_9) + "</SD_9>" + NL;
    s += "<SD_10>" + f(this.SD_10) + "</SD_10>" + NL;
    s += "</AlarmsAssociatedValues>" + NL;
    return s;
  }

  static fromValueBlob(blob: ValueBlobArray): AlarmsAssociatedValues {
    const av = new AlarmsAssociatedValues();
    const blobs = blob.getValue();
    // Comes as Array[17], with indices:
    // 0 = Unknown Typeinformation, 4 Bytes
    // 1..10 = SD_1..SD_10
    //
    // The typeinformation at index 0 has a BlobRootId of 3476 = AS_CGS.AssociatedValues
    // When browsing 0x2000113 we get the result:
    // Type   Name
    // ---------------
    // UInt   Syntax
    // Byte   Aap
    let i = 0;
    let pv: AssociatedValue;
    for (const b of blobs) {
      const bytes = b.getValue()!;
      const id = b.blobRootId;
      switch (id) {
        case Ids.TI_BOOL:
          pv = new AssociatedValue(id);
          pv.setBool(bytes[0] !== 0);
          av.setSDValue(pv, i);
          break;
        case Ids.TI_BYTE:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(bytes[0]));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_CHAR:
          pv = new AssociatedValue(id);
          pv.setString(latin1(bytes, 0, 1));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_WORD:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getUInt16(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_INT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getInt16(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_DWORD:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getUInt32(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_DINT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getInt32(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_REAL:
          pv = new AssociatedValue(id);
          pv.setReal(Utils.getFloat(bytes, 0));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_LREAL:
          pv = new AssociatedValue(id);
          pv.setReal(Utils.getDouble(bytes, 0));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_USINT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(bytes[0]));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_UINT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getUInt16(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_UDINT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt(Utils.getUInt32(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_SINT:
          pv = new AssociatedValue(id);
          pv.setInt(BigInt((bytes[0] << 24) >> 24));
          av.setSDValue(pv, i);
          break;
        case Ids.TI_WCHAR:
          pv = new AssociatedValue(id);
          pv.setString(String.fromCharCode(Utils.getUInt16(bytes, 0)));
          av.setSDValue(pv, i);
          break;
        default:
          if (id > Ids.TI_STRING_START && id <= Ids.TI_STRING_END) {
            //byte s_maxlen = bytes[0]; // Don't need this value
            const sActlen = bytes[1];
            pv = new AssociatedValue(Ids.TI_STRING);
            pv.setString(latin1(bytes, 2, sActlen));
            av.setSDValue(pv, i);
          } else if (id > Ids.TI_WSTRING_START && id <= Ids.TI_WSTRING_END) {
            //int ws_maxlen = Utils.GetUInt16(bytes, 0); // Don't need this value
            const wsActlen = Utils.getUInt16(bytes, 2);
            pv = new AssociatedValue(Ids.TI_WSTRING);
            pv.setString(utf16be(bytes, 4, wsActlen * 2));
            av.setSDValue(pv, i);
          }
          break;
      }
      i++;
      // All other elements have no value
      if (i > 10) {
        break;
      }
    }
    return av;
  }

  private setSDValue(v: AssociatedValue, index: number): void {
    switch (index) {
      case 1: this.SD_1 = v; break;
      case 2: this.SD_2 = v; break;
      case 3: this.SD_3 = v; break;
      case 4: this.SD_4 = v; break;
      case 5: this.SD_5 = v; break;
      case 6: this.SD_6 = v; break;
      case 7: this.SD_7 = v; break;
      case 8: this.SD_8 = v; break;
      case 9: this.SD_9 = v; break;
      case 10: this.SD_10 = v; break;
    }
  }
}

export class AssociatedValue {
  private valueBool = false;
  private valueInt = 0n;
  private valueReal = 0;
  private valueString = "";

  typeInfo: number;
  // Allowed types in plc program: Bool, Byte, Char, DInt, DWord, Int, LReal, Real, SInt, String, UDInt, UInt, WChar, Word, WString
  // Break down to types which can handle all these values: boolean, bigint, number, string

  constructor(typeinfo: number) {
    this.typeInfo = typeinfo;
  }

  setBool(value: boolean): void {
    this.valueBool = value;
  }

  setInt(value: bigint): void {
    this.valueInt = value;
  }

  setReal(value: number): void {
    this.valueReal = value;
  }

  setString(value: string): void {
    this.valueString = value;
  }

  toString(): string {
    let s = "";
    switch (this.typeInfo) {
      case Ids.TI_BOOL:
        s = this.valueBool ? "True" : "False";
        break;
      case Ids.TI_BYTE:
      case Ids.TI_WORD:
      case Ids.TI_INT:
      case Ids.TI_DWORD:
      case Ids.TI_DINT:
      case Ids.TI_USINT:
      case Ids.TI_UINT:
      case Ids.TI_UDINT:
      case Ids.TI_SINT:
        s = this.valueInt.toString();
        break;
      case Ids.TI_REAL:
      case Ids.TI_LREAL:
        s = this.valueReal.toString();
        break;
      case Ids.TI_CHAR:
      case Ids.TI_WCHAR:
      case Ids.TI_STRING:
      case Ids.TI_WSTRING:
        s = this.valueString;
        break;
    }
    return s;
  }
}
