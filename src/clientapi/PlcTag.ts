/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */
import type { ItemAddress } from "./ItemAddress.js";
import { PlcTagQC } from "./PlcTagQC.js";
import {
  PValue,
  ValueBool,
  ValueByte,
  ValueUSInt,
  ValueWord,
  ValueInt,
  ValueDWord,
  ValueDInt,
  ValueReal,
  ValueUInt,
  ValueUDInt,
  ValueUSIntArray,
  ValueLReal,
  ValueULInt,
  ValueLInt,
  ValueLWord,
  ValueSInt,
  ValueUIntArray,
  ValueTimespan,
  ValueTimestamp,
  ValueStruct,
  ValueByteArray,
  ValueBoolArray,
  ValueWordArray,
  ValueIntArray,
  ValueDWordArray,
  ValueDIntArray,
  ValueRealArray,
  ValueUDIntArray,
  ValueSIntArray,
} from "../core/PValue.js";

/* Ideas for improvement:
 * - Optional initial value in constructor
 * - Uniform the different PLC datatypes on the biggest type,
 *   to reduce the amount of types (e.g. on integer types only 64 bit).
 * Many datatypes differ only by the type in the protocol.
 * But there's some special handling needed for type like String, WString, date/time etc.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PValueCtor = new (...args: any[]) => PValue;

// ---------------------------------------------------------------------------
// Helpers (replacing System.Text.Encoding / DateTime / String.Format features)
// ---------------------------------------------------------------------------

function normEncoding(encoding: string): string {
  return encoding.toLowerCase().replace(/_/g, "-");
}

/** Encoding.GetEncoding(enc).GetBytes(str) */
function encodeText(str: string, encoding: string): Uint8Array {
  switch (normEncoding(encoding)) {
    case "iso-8859-1":
    case "latin1":
    case "us-ascii":
    case "ascii":
      return new Uint8Array(Buffer.from(str, "latin1"));
    case "utf-8":
    case "utf8":
      return new TextEncoder().encode(str);
    case "utf-16":
    case "utf-16le":
    case "unicode":
      return new Uint8Array(Buffer.from(str, "utf16le"));
    default:
      throw new Error("Unsupported encoding: " + encoding);
  }
}

/** Encoding.GetEncoding(enc).GetString(bytes, index, count) */
function decodeText(bytes: ArrayLike<number>, index: number, count: number, encoding: string): string {
  const sub = Uint8Array.from(Array.prototype.slice.call(bytes, index, index + count) as number[]);
  switch (normEncoding(encoding)) {
    case "iso-8859-1":
    case "latin1":
    case "us-ascii":
    case "ascii":
      return Buffer.from(sub).toString("latin1");
    case "utf-16":
    case "utf-16le":
    case "unicode":
      return Buffer.from(sub).toString("utf16le");
    default:
      return new TextDecoder(encoding).decode(sub);
  }
}

function pad(n: number | bigint, width: number): string {
  const neg = n < 0;
  let s = (neg ? -n : n).toString();
  while (s.length < width) s = "0" + s;
  return neg ? "-" + s : s;
}

function hex2(n: number): string {
  let s = n.toString(16).toUpperCase();
  while (s.length < 2) s = "0" + s;
  return s;
}

/** Shortest round-trip representation of a single precision float (like .NET float.ToString()). */
function floatToString(v: number): string {
  if (!Number.isFinite(v) || v === 0) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(parseFloat(s)) === v) return String(parseFloat(s));
  }
  return String(v);
}

/** DateTime.ToString() with the invariant culture: MM/dd/yyyy HH:mm:ss */
function dateTimeToString(d: Date): string {
  return (
    pad(d.getMonth() + 1, 2) + "/" + pad(d.getDate(), 2) + "/" + pad(d.getFullYear(), 4) + " " +
    pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2)
  );
}

/** DateTime.ToShortDateString() with the invariant culture: MM/dd/yyyy */
function dateToShortString(d: Date): string {
  return pad(d.getMonth() + 1, 2) + "/" + pad(d.getDate(), 2) + "/" + pad(d.getFullYear(), 4);
}

function addMilliseconds(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

// ---------------------------------------------------------------------------

export abstract class PlcTag {
  name: string;
  address: ItemAddress;
  quality: number;
  datatype: number;

  lastReadError = 0n;
  lastWriteError = 0n;

  constructor(name: string, address: ItemAddress, softdatatype: number) {
    this.name = name;
    this.address = address;
    this.datatype = softdatatype;
    this.quality = PlcTagQC.TAG_QUALITY_WAITING_FOR_INITIAL_DATA;
  }

  abstract processReadResult(obj: unknown, error: bigint): void;

  processWriteResult(error: bigint): void {
    this.lastWriteError = error;
  }

  abstract getWriteValue(): PValue;

  protected static checkErrorAndType(error: bigint, valueObj: unknown, checkType: PValueCtor): number {
    let res: number;
    if (error !== 0n) {
      console.log("CheckErrorAndType(): error=" + error);
      res = -1;
    } else if ((valueObj as object | null | undefined)?.constructor !== checkType) {
      console.log(
        "CheckErrorAndType(): Type of value is not as excpected. Expected: " + checkType.name +
          " Received: " + (valueObj as object | null | undefined)?.constructor?.name + ".",
      );
      res = -1;
    } else {
      res = 0;
    }
    return res;
  }

  protected static resultString(tag: PlcTag, value: string): string {
    return hex2(tag.quality) + ": " + value;
  }

  protected static bcdByteToInt(value: number): number {
    return 10 * Math.trunc(value / 16) + (value % 16);
  }

  protected static intToBcdByte(value: number): number {
    return (Math.trunc(value / 10) * 16 + (value % 10)) & 0xff;
  }

  protected static bcdUshortToUshort(value: number): number {
    return ((value & 0x000f) + ((value & 0x00f0) >> 4) * 10 + ((value & 0x0f00) >> 8) * 100 + ((value & 0xf000) >> 12) * 1000) & 0xffff;
  }

  protected static ushortToBcdUshort(value: number): number {
    const b = [0, 0, 0, 0];
    b[0] = value % 10;
    value = Math.trunc(value / 10);
    b[1] = value % 10;
    value = Math.trunc(value / 10);
    b[2] = value % 10;
    value = Math.trunc(value / 10);
    b[3] = value % 10;
    return (b[0] + (b[1] << 4) + (b[2] << 8) + (b[3] << 12)) & 0xffff;
  }
}

/**
 * Internal helper base for tags with a plain scalar/array value that maps 1:1 to one PValue type.
 * (Replaces the identical per-class boilerplate of the C# code; behaviour is the same.)
 */
abstract class PlcTagSimple<T> extends PlcTag {
  abstract value: T;
  protected abstract readonly valueType: PValueCtor;
  protected abstract fromPValue(v: PValue): T;
  protected abstract toPValue(): PValue;
  protected valueToString(): string {
    return String(this.value);
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, this.valueType) === 0) {
      this.value = this.fromPValue(valueObj as PValue);
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return this.toPValue();
  }

  override toString(): string {
    return PlcTag.resultString(this, this.valueToString());
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export class PlcTagBool extends PlcTagSimple<boolean> {
  value = false;
  protected readonly valueType = ValueBool;
  protected fromPValue(v: PValue): boolean { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueBool(this.value); }
  protected override valueToString(): string { return this.value ? "True" : "False"; }
}

export class PlcTagByte extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueByte;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueByte(this.value); }
}

export class PlcTagChar extends PlcTag {
  private _value = "\0";
  private encoding = "ISO-8859-1";

  get value(): string { return this._value; }
  set value(v: string) { this._value = v; } // TODO: check if fits in ASCII area, include the encoding?

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSInt) === 0) {
      const v = new Uint8Array(1);
      v[0] = (valueObj as any).getValue();
      this.value = decodeText(v, 0, 1, this.encoding)[0];
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const b = encodeText(this.value, this.encoding);
    return new ValueUSInt(b[0]);
  }

  setCharEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  override toString(): string {
    return PlcTag.resultString(this, this.value);
  }
}

export class PlcTagWord extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueWord;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueWord(this.value); }
}

export class PlcTagInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueInt(this.value); }
}

export class PlcTagDWord extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueDWord;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueDWord(this.value); }
}

export class PlcTagDInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueDInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueDInt(this.value); }
}

export class PlcTagReal extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueReal;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueReal(this.value); }
  protected override valueToString(): string { return floatToString(this.value); }
}

export class PlcTagDate extends PlcTag {
  // Specifies the number of days from January 1, 1990.
  // JS has no type with only date or only time
  private _value: Date = new Date(1990, 0, 1);

  get value(): Date { return this._value; }
  set value(v: Date) {
    if (v.getTime() >= new Date(1990, 0, 1).getTime() && v.getTime() <= new Date(2169, 5, 6).getTime()) {
      this._value = v;
    } else {
      throw new RangeError("Date must be >= 1990-01-01 and <= 2169-06-06 (Parameter 'Value')");
    }
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUInt) === 0) {
      const v: number = (valueObj as any).getValue();
      this.value = new Date(1990, 0, 1 + v);
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const d = this.value;
    const days = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1990, 0, 1)) / 86400000);
    return new ValueUInt(days & 0xffff);
  }

  override toString(): string {
    return PlcTag.resultString(this, dateToShortString(this.value));
  }
}

export class PlcTagTimeOfDay extends PlcTag {
  // Specification: 01:02:03 = 3723000 number of milliseconds since 00:00:00
  private _value = 0;

  /** Number of milliseconds since 00:00:00, must be below 86400000ms */
  get value(): number { return this._value; }
  set value(v: number) {
    if (v < 86400000) {
      this._value = v;
    } else {
      throw new RangeError("Number if milliseconds must be < 86400000 (Parameter 'Value')");
    }
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUDInt) === 0) {
      this.value = (valueObj as any).getValue();
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return new ValueUDInt(this.value);
  }

  override toString(): string {
    let v = this.value;
    const ms = v % 1000;
    v = Math.trunc(v / 1000);
    const s = v % 60;
    v = Math.trunc(v / 60);
    const m = v % 60;
    v = Math.trunc(v / 60);
    const h = v;
    let tod: string;
    if (ms > 0) {
      tod = pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(ms, 3);
    } else {
      tod = pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2);
    }
    return PlcTag.resultString(this, tod);
  }
}

export class PlcTagTime extends PlcTagSimple<number> {
  /** In milliseconds, with sign */
  value = 0;
  protected readonly valueType = ValueDInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueDInt(this.value); }

  override toString(): string {
    const divs = [86400000, 3600000, 60000, 1000, 1];
    const vfmt = [(v: number) => v + "d", (v: number) => pad(v, 2) + "h", (v: number) => pad(v, 2) + "m", (v: number) => pad(v, 2) + "s", (v: number) => pad(v, 3) + "ms"];
    let vtime = this.value;
    let timeNegative = false;
    let val: number;
    let ts = "";
    if (vtime === 0) {
      ts = "0ms";
    } else {
      if (vtime < 0) {
        ts = "-";
        timeNegative = true;
        for (let i = 0; i < 5; i++) {
          divs[i] = -divs[i];
        }
      }

      for (let i = 0; i < 5; i++) {
        val = Math.trunc(vtime / divs[i]);
        vtime -= val * divs[i];
        if (val > 0) {
          ts += vfmt[i](val);
          if ((!timeNegative && vtime > 0) || (timeNegative && vtime < 0)) {
            ts += "_";
          }
        }
      }
    }
    return PlcTag.resultString(this, ts);
  }
}

export class PlcTagS5Time extends PlcTag {
  // Specification S5Time:
  // Bits 15, 14: not used
  // Bits 13, 12: time base in binary, 00=10ms, 01=100ms, 10=1s, 11=10s
  // Bits 11..0: time values BCD coded (0 to 999)
  // S5Time_9S_990MS = <Value type="Word">2457</Value>
  // S5Time_2H_46M_30S_0MS = <Value type="Word">14745</Value>
  private _timeValue = 0;
  private _timeBase = 0;

  /** TimeValue: between 0..999, factor is TimeBase */
  get timeValue(): number { return this._timeValue; }
  set timeValue(v: number) {
    if (v >= 0 && v <= 999) {
      this._timeValue = v;
    } else {
      throw new RangeError("TimeValue must be >= 0 and <= 999 (Parameter 'Value')");
    }
  }

  /** TimeBase 0=10ms, 1=100ms, 2=1s, 3=10s */
  get timeBase(): number { return this._timeBase; }
  set timeBase(v: number) {
    if (v >= 0 && v <= 3) {
      this._timeBase = v;
    } else {
      throw new RangeError("TimeBase must be >= 0 and <= 3 (Parameter 'Value')");
    }
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueWord) === 0) {
      const v: number = (valueObj as any).getValue();
      this.timeValue = PlcTag["bcdUshortToUshort"](v & 0x0fff);
      this.timeBase = (v & 0x3000) >> 12;
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    let v = PlcTag["ushortToBcdUshort"](this.timeValue);
    v |= (this.timeBase & 0x3) << 12;
    return new ValueWord(v & 0xffff);
  }

  override toString(): string {
    let s = "";
    // Scale down to milliseconds
    switch (this.timeBase) {
      case 0:
        s = (this.timeValue * 10).toString() + "ms";
        break;
      case 1:
        s = (this.timeValue * 100).toString() + "ms";
        break;
      case 2:
        s = (this.timeValue * 1000).toString() + "ms";
        break;
      case 3:
        s = (this.timeValue * 10000).toString() + "ms";
        break;
    }
    return PlcTag.resultString(this, s);
  }
}

export class PlcTagDateAndTime extends PlcTag {
  /* BCD coded:
   * YYMMDDhhmmssuuuQ
   * uuu = milliseconds
   * Q = Weekday 1=Su, 2=Mo, 3=Tu, 4=We, 5=Th, 6=Fr, 7=Sa
   */
  private _value: Date = new Date(1990, 0, 1);

  get value(): Date { return this._value; }
  set value(v: Date) {
    if (v.getTime() >= new Date(1990, 0, 1).getTime() && v.getTime() < new Date(2090, 0, 1).getTime()) {
      this._value = v;
    } else {
      throw new RangeError("DateTime must be >= 1990-01-01 and < 2090-01-01 (Parameter 'Value')");
    }
  }

  constructor(name: string, address: ItemAddress, softdatatype: number) {
    super(name, address, softdatatype);
    this.value = new Date(1990, 0, 1);
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      const v: ArrayLike<number> = (valueObj as any).getValue();
      const ts: number[] = new Array(8).fill(0);
      for (let i = 0; i < 7; i++) {
        ts[i] = PlcTag["bcdByteToInt"](v[i]);
      }
      // The left nibble of the last byte contains the LSD of milliseconds,
      // the right nibble the weekday (which we don't process here).
      ts[7] = v[7] >> 4;

      let year: number;
      if (ts[0] >= 90) {
        year = 1900 + ts[0];
      } else {
        year = 2000 + ts[0];
      }
      this.value = new Date(year, ts[1] - 1, ts[2], ts[3], ts[4], ts[5]);
      this.value = addMilliseconds(this.value, ts[6] * 10 + ts[7]);

      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const ts: number[] = new Array(8).fill(0);
    const b = new Uint8Array(8);
    const value = this.value;
    if (value.getFullYear() < 2000) {
      // 90-99 = 1990-1999
      ts[0] = value.getFullYear() - 1900;
    } else {
      // 00-89 = 2000-2089
      ts[0] = value.getFullYear() - 2000;
    }
    ts[1] = value.getMonth() + 1;
    ts[2] = value.getDate();
    ts[3] = value.getHours();
    ts[4] = value.getMinutes();
    ts[5] = value.getSeconds();
    ts[6] = Math.trunc(value.getMilliseconds() / 10);
    ts[7] = (value.getMilliseconds() % 10) << 4; // Don't set the weekday
    for (let i = 0; i < 7; i++) {
      b[i] = PlcTag["intToBcdByte"](ts[i]);
    }
    b[7] = ts[7] & 0xff;
    return new ValueUSIntArray(b);
  }

  override toString(): string {
    let ts = dateTimeToString(this.value);
    if (this.value.getMilliseconds() > 0) {
      ts += "." + pad(this.value.getMilliseconds(), 3);
    }
    return PlcTag.resultString(this, ts);
  }
}

export class PlcTagString extends PlcTag {
  private _value = "";
  private maxLength = 254;
  private encoding = "ISO-8859-1";

  get value(): string { return this._value; }
  set value(v: string) {
    if (v.length <= this.maxLength) {
      this._value = v;
    } else {
      throw new RangeError("String is longer than the allowed max. length of " + this.maxLength + " (Parameter 'Value')");
    }
  }

  constructor(name: string, address: ItemAddress, softdatatype: number, maxlength = 254) {
    super(name, address, softdatatype);
    this.maxLength = maxlength;
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      const v: ArrayLike<number> = (valueObj as any).getValue();
      const actLen = v[1];
      // IEC 61131-3 states ISO-646 IRV, with optional extensions like "Latin-1 Supplement".
      // Siemens TIA-Portal gives warnings using other than 7 Bit ASCII characters.
      // Let the user define his local encoding via SetStringEncoding().
      this.value = decodeText(v, 2, actLen, this.encoding);
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    // Must write the complete array of MaxLength of the string (plus two bytes header).
    const sb = encodeText(this.value, this.encoding);
    const b = new Uint8Array(this.maxLength + 2);
    b[0] = this.maxLength;
    b[1] = sb.length;
    for (let i = 0; i < sb.length; i++) {
      b[i + 2] = sb[i];
    }
    return new ValueUSIntArray(b);
  }

  setStringEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  override toString(): string {
    return PlcTag.resultString(this, this.value);
  }
}

export class PlcTagPointer extends PlcTag {
  value: Uint8Array = new Uint8Array(6);

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      this.value = (valueObj as any).getValue();
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return new ValueUSIntArray(this.value);
  }

  override toString(): string {
    const v = this.value;
    const dbnr = v[0] * 256 + v[1];
    const area = v[2];
    const bitnr = v[5] & 0x7;
    const bytenr = (v[5] >> 3) + v[4] * 32 + (v[3] & 0x7) * 8192;
    return PlcTag.resultString(this, `DB=${dbnr} Area=0x${hex2(area)} Byte=${bytenr} Bit=${bitnr}`);
  }
}

export class PlcTagAny extends PlcTag {
  value: Uint8Array = new Uint8Array(10);

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      this.value = (valueObj as any).getValue();
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return new ValueUSIntArray(this.value);
  }

  override toString(): string {
    const v = this.value;
    const hdr = v[0];
    const datatype = v[1];
    const factor = v[2] * 256 + v[3];
    const dbnr = v[4] * 256 + v[5];
    const area = v[6];
    const bitnr = v[9] & 0x7;
    const bytenr = (v[9] >> 3) + v[8] * 32 + (v[7] & 0x7) * 8192;

    return PlcTag.resultString(
      this,
      `HDR=${hex2(hdr)} Type=${hex2(datatype)} Factor=${factor} DB=${dbnr} Area=0x${hex2(area)} Byte=${bytenr} Bit=${bitnr}`,
    );
  }
}

export class PlcTagLReal extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueLReal;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueLReal(this.value); }
}

export class PlcTagULInt extends PlcTagSimple<bigint> {
  value = 0n;
  protected readonly valueType = ValueULInt;
  protected fromPValue(v: PValue): bigint { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueULInt(this.value); }
}

export class PlcTagLInt extends PlcTagSimple<bigint> {
  value = 0n;
  protected readonly valueType = ValueLInt;
  protected fromPValue(v: PValue): bigint { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueLInt(this.value); }
}

export class PlcTagLWord extends PlcTagSimple<bigint> {
  value = 0n;
  protected readonly valueType = ValueLWord;
  protected fromPValue(v: PValue): bigint { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueLWord(this.value); }
}

export class PlcTagUSInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueUSInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUSInt(this.value); }
}

export class PlcTagUInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueUInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUInt(this.value); }
}

export class PlcTagUDInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueUDInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUDInt(this.value); }
}

export class PlcTagSInt extends PlcTagSimple<number> {
  value = 0;
  protected readonly valueType = ValueSInt;
  protected fromPValue(v: PValue): number { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueSInt(this.value); }
}

export class PlcTagWChar extends PlcTag {
  value = "\0";

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUInt) === 0) {
      this.value = String.fromCharCode((valueObj as any).getValue());
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return new ValueUInt(this.value.charCodeAt(0));
  }

  override toString(): string {
    return PlcTag.resultString(this, this.value);
  }
}

export class PlcTagWString extends PlcTag {
  private _value = "";
  private maxLength = 254;

  get value(): string { return this._value; }
  set value(v: string) {
    if (v.length <= this.maxLength) {
      this._value = v;
    } else {
      throw new RangeError("String is longer than the allowed max. length of " + this.maxLength + " (Parameter 'Value')");
    }
  }

  constructor(name: string, address: ItemAddress, softdatatype: number, maxlength = 254) {
    super(name, address, softdatatype);
    this.maxLength = maxlength;
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUIntArray) === 0) {
      const v: ArrayLike<number> = (valueObj as any).getValue();
      const actLen = v[1];

      // Buffer.BlockCopy(v, 4, b, 0, act_len * 2) -> UTF-16LE code units starting at element 2
      let s = "";
      for (let i = 0; i < actLen; i++) {
        s += String.fromCharCode(v[2 + i]);
      }
      this.value = s;
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    // Must write the complete array of MaxLength of the string (plus two ushort for the header).
    const b: number[] = new Array(this.value.length + 2).fill(0);
    b[0] = this.maxLength;
    b[1] = this.value.length;
    for (let i = 0; i < this.value.length; i++) {
      b[i + 2] = this.value.charCodeAt(i);
    }
    return new ValueUIntArray(b);
  }

  override toString(): string {
    return PlcTag.resultString(this, this.value);
  }
}

export class PlcTagLTime extends PlcTagSimple<bigint> {
  value = 0n;
  protected readonly valueType = ValueTimespan;
  protected fromPValue(v: PValue): bigint { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueTimespan(this.value); }
  protected override valueToString(): string { return ValueTimespan.toStringValue(this.value); }
}

export class PlcTagLTOD extends PlcTag {
  // Specification: Number of nanoseconds since 00:00:00.
  private _value = 0n;

  /** Number of nanoseconds since 00:00:00, must be below 86400000000000ns */
  get value(): bigint { return this._value; }
  set value(v: bigint) {
    if (v < 86400000000000n) {
      this._value = v;
    } else {
      throw new RangeError("Number if nanoseconds must be < 86400000000000 (Parameter 'Value')");
    }
    this._value = v;
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueULInt) === 0) {
      this.value = (valueObj as any).getValue();
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    return new ValueULInt(this.value);
  }

  override toString(): string {
    let v = this.value;
    const ns = v % 1000000000n;
    v /= 1000000000n;
    const s = v % 60n;
    v /= 60n;
    const m = v % 60n;
    v /= 60n;
    const h = v;
    let tod: string;
    if (ns > 0n) {
      tod = pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(ns, 9);
    } else {
      tod = pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2);
    }
    return PlcTag.resultString(this, tod);
  }
}

export class PlcTagLDT extends PlcTagSimple<bigint> {
  value = 0n;
  protected readonly valueType = ValueTimestamp;
  protected fromPValue(v: PValue): bigint { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueTimestamp(this.value); }
  protected override valueToString(): string { return ValueTimestamp.toStringValue(this.value); }
}

export class PlcTagDTL extends PlcTag {
  private _value: Date = new Date(1970, 0, 1);
  private _valueNanosecond = 0;

  get value(): Date { return this._value; }
  set value(v: Date) {
    if (v.getTime() >= new Date(1970, 0, 1).getTime() && v.getTime() <= new Date(2262, 3, 11, 23, 47, 16).getTime()) {
      this._value = v;
    } else {
      throw new RangeError("DateTime must be >= 1970-01-01 and <= 2262-04-11 23:47:16 (Parameter 'Value')");
    }
  }

  get valueNanosecond(): number { return this._valueNanosecond; }
  set valueNanosecond(v: number) {
    if (v <= 999999999) {
      this._valueNanosecond = v;
    } else {
      throw new RangeError("Nanosecond must be <= 999999999 (Parameter 'Value')");
    }
  }

  // Oct 23, 2008 16:38:30.406829900 UTC. Should be used from first browse method (or read) and set correctly
  dtlInterfaceTimestamp = 0x10ff4ad6dfd5774cn;

  constructor(name: string, address: ItemAddress, softdatatype: number) {
    super(name, address, softdatatype);
    this.value = new Date(1970, 0, 1);
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueStruct) === 0) {
      const structVal = valueObj as ValueStruct;
      // That value is the ID which has the type description
      // E.g. DTL 33554499 = TI_LIB.SimpleType.67
      // Then comes a PackedStruct, with Interface timestamp, transportflags, and a ByteArray with 12 bytes.
      // Generate the separate values back from the array:
      // 0, 1: YEAR, UInt
      // 2: MONTH, USInt
      // 3: DAY, USInt
      // 4: WEEKDAY, USInt
      // 5: HOUR, USInt
      // 6: MINUTE, USInt
      // 7: SECOND, USInt
      // 8, 9, 10, 11: NANOSECOND, UDInt

      // Use the default timestamp, or refresh it from browsing the plc, or from reading dtl first
      this.dtlInterfaceTimestamp = (structVal as any).packedStructInterfaceTimestamp;

      if ((structVal as any).getValue() === 0x02000043) {
        const elem = (structVal as any).getStructElement(0x02000043);
        if (elem?.constructor === ValueByteArray) {
          const barr: ArrayLike<number> = elem.getValue();
          const year = barr[0] * 256 + barr[1];
          this.valueNanosecond = ((barr[8] * 16777216 + barr[9] * 65536 + barr[10] * 256 + barr[11]) >>> 0);
          this.value = new Date(year, barr[2] - 1, barr[3], barr[5], barr[6], barr[7]);
          this.quality = PlcTagQC.TAG_QUALITY_GOOD;
        } else {
          this.quality = PlcTagQC.TAG_QUALITY_BAD;
        }
      } else {
        this.quality = PlcTagQC.TAG_QUALITY_BAD;
      }
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const structVal: any = new ValueStruct(0x02000043); // 0x02000043 = TI_LIB.SimpleType.67 -> DTL Systemdatatype
    structVal.packedStructInterfaceTimestamp = this.dtlInterfaceTimestamp;
    const barr = new Uint8Array(12);
    const year = this.value.getFullYear();
    barr[0] = (year >> 8) & 0xff;
    barr[1] = year & 0xff;
    barr[2] = this.value.getMonth() + 1;
    barr[3] = this.value.getDate();
    barr[4] = 0; // Weekday, don't set
    barr[5] = this.value.getHours();
    barr[6] = this.value.getMinutes();
    barr[7] = this.value.getSeconds();
    barr[8] = (this.valueNanosecond >>> 24) & 0xff;
    barr[9] = (this.valueNanosecond >>> 16) & 0xff;
    barr[10] = (this.valueNanosecond >>> 8) & 0xff;
    barr[11] = this.valueNanosecond & 0xff;
    structVal.addStructElement(0x02000043, new ValueByteArray(barr));
    return structVal;
  }

  override toString(): string {
    let width: number;
    let ns = this.valueNanosecond;
    if (ns % 1000 > 0) {
      width = 9;
    } else if (ns % 1000000 > 0) {
      width = 6;
      ns = Math.trunc(ns / 1000);
    } else if (ns % 1000000000 > 0) {
      width = 3;
      ns = Math.trunc(ns / 1000000);
    } else {
      return dateTimeToString(this.value);
    }
    return dateTimeToString(this.value) + "." + pad(ns, width);
  }
}

// #region Arrays

export class PlcTagBoolArray extends PlcTagSimple<boolean[]> {
  value: boolean[] = [false];
  protected readonly valueType = ValueBoolArray;
  protected fromPValue(v: PValue): boolean[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueBoolArray(this.value); }
  protected override valueToString(): string { return new ValueBoolArray(this.value).toString(); }
}

export class PlcTagByteArray extends PlcTagSimple<Uint8Array> {
  value: Uint8Array = new Uint8Array(1);
  protected readonly valueType = ValueByteArray;
  protected fromPValue(v: PValue): Uint8Array { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueByteArray(this.value); }
  protected override valueToString(): string { return new ValueByteArray(this.value).toString(); }
}

export class PlcTagWordArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueWordArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueWordArray(this.value); }
  protected override valueToString(): string { return new ValueWordArray(this.value).toString(); }
}

export class PlcTagIntArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueIntArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueIntArray(this.value); }
  protected override valueToString(): string { return new ValueIntArray(this.value).toString(); }
}

export class PlcTagDWordArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueDWordArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueDWordArray(this.value); }
  protected override valueToString(): string { return new ValueDWordArray(this.value).toString(); }
}

export class PlcTagDIntArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueDIntArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueDIntArray(this.value); }
  protected override valueToString(): string { return new ValueDIntArray(this.value).toString(); }
}

export class PlcTagRealArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueRealArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueRealArray(this.value); }
  protected override valueToString(): string { return new ValueRealArray(this.value).toString(); }
}

export class PlcTagUSIntArray extends PlcTagSimple<Uint8Array> {
  value: Uint8Array = new Uint8Array(1);
  protected readonly valueType = ValueUSIntArray;
  protected fromPValue(v: PValue): Uint8Array { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUSIntArray(this.value); }
  protected override valueToString(): string { return new ValueUSIntArray(this.value).toString(); }
}

export class PlcTagUIntArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueUIntArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUIntArray(this.value); }
  protected override valueToString(): string { return new ValueUIntArray(this.value).toString(); }
}

export class PlcTagUDIntArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueUDIntArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueUDIntArray(this.value); }
  protected override valueToString(): string { return new ValueUDIntArray(this.value).toString(); }
}

export class PlcTagSIntArray extends PlcTagSimple<number[]> {
  value: number[] = [0];
  protected readonly valueType = ValueSIntArray;
  protected fromPValue(v: PValue): number[] { return (v as any).getValue(); }
  protected toPValue(): PValue { return new ValueSIntArray(this.value); }
  protected override valueToString(): string { return new ValueSIntArray(this.value).toString(); }
}

export class PlcTagDateAndTimeArray extends PlcTag {
  /* BCD coded:
   * YYMMDDhhmmssuuuQ
   * uuu = milliseconds
   * Q = Weekday 1=Su, 2=Mo, 3=Tu, 4=We, 5=Th, 6=Fr, 7=Sa
   */
  private _value: Date[] = [];

  get value(): Date[] { return this._value; }
  set value(v: Date[]) {
    let dataOk = true;
    for (const item of v) {
      // (sic) C# original uses && here, so this check can never fail. Kept for parity.
      if (item.getTime() < new Date(1990, 0, 1).getTime() && item.getTime() >= new Date(2090, 0, 1).getTime()) {
        dataOk = false;
        break;
      }
    }
    if (dataOk) {
      this._value = v;
    } else {
      throw new RangeError("DateTime must be >= 1990-01-01 and < 2090-01-01 (Parameter 'Value')");
    }
  }

  constructor(name: string, address: ItemAddress, softdatatype: number) {
    super(name, address, softdatatype);
    this.value = [];
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      const dateTimes: Date[] = [];
      const v: ArrayLike<number> = (valueObj as any).getValue();
      let pos = 0;
      do {
        const ts: number[] = new Array(8).fill(0);
        for (let i = 0; i < 7; i++) {
          ts[i] = PlcTag["bcdByteToInt"](v[pos + i]);
        }
        // The left nibble of the last byte contains the LSD of milliseconds,
        // the right nibble the weekday (which we don't process here).
        ts[7] = v[7] >> 4;

        let year: number;
        if (ts[0] >= 90) {
          year = 1900 + ts[0];
        } else {
          year = 2000 + ts[0];
        }
        let value = new Date(year, ts[1] - 1, ts[2], ts[3], ts[4], ts[5]);
        value = addMilliseconds(value, ts[6] * 10 + ts[7]);
        dateTimes.push(value);
        pos += 8;
      } while (pos < v.length);
      this.value = dateTimes;
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const byteStrings: number[] = [];
    for (const item of this.value) {
      const ts: number[] = new Array(8).fill(0);
      const b = new Uint8Array(8);
      if (item.getFullYear() < 2000) {
        // 90-99 = 1990-1999
        ts[0] = item.getFullYear() - 1900;
      } else {
        // 00-89 = 2000-2089
        ts[0] = item.getFullYear() - 2000;
      }
      ts[1] = item.getMonth() + 1;
      ts[2] = item.getDate();
      ts[3] = item.getHours();
      ts[4] = item.getMinutes();
      ts[5] = item.getSeconds();
      ts[6] = Math.trunc(item.getMilliseconds() / 10);
      ts[7] = (item.getMilliseconds() % 10) << 4; // Don't set the weekday
      for (let i = 0; i < 7; i++) {
        b[i] = PlcTag["intToBcdByte"](ts[i]);
      }
      b[7] = ts[7] & 0xff;
      byteStrings.push(...b);
    }
    return new ValueUSIntArray(new Uint8Array(byteStrings));
  }

  override toString(): string {
    let s = '<Value type ="DateAndTimeArray" size="' + this.value.length.toString() + '">';
    for (let i = 0; i < this.value.length; i++) {
      let ts = dateTimeToString(this.value[i]);
      if (this.value[i].getMilliseconds() > 0) {
        ts += "." + pad(this.value[i].getMilliseconds(), 3);
      }
      s += `<Value>${ts}</Value>`;
    }
    s += "</Value>";
    return PlcTag.resultString(this, s);
  }
}

export class PlcTagStringArray extends PlcTag {
  private _value: string[] = [];
  private maxLength = 254;
  private encoding = "ISO-8859-1";

  get value(): string[] { return this._value; }
  set value(v: string[]) {
    let lengthOk = true;
    for (const item of v) {
      if (item.length > this.maxLength) {
        lengthOk = false;
        break;
      }
    }
    if (lengthOk) {
      this._value = v;
    } else {
      throw new RangeError("String is longer than the allowed max. length of " + this.maxLength + " (Parameter 'Value')");
    }
  }

  constructor(name: string, address: ItemAddress, softdatatype: number, maxlength = 254) {
    super(name, address, softdatatype);
    this.maxLength = maxlength;
  }

  processReadResult(valueObj: unknown, error: bigint): void {
    this.lastReadError = error;
    if (PlcTag.checkErrorAndType(error, valueObj, ValueUSIntArray) === 0) {
      const strings: string[] = [];
      const v: ArrayLike<number> = (valueObj as any).getValue();
      let pos = 0;
      do {
        const maxLen = v[pos];
        const actLen = v[pos + 1];
        // IEC 61131-3 states ISO-646 IRV, with optional extensions like "Latin-1 Supplement".
        // Siemens TIA-Portal gives warnings using other than 7 Bit ASCII characters.
        // Let the user define his local encoding via SetStringEncoding().
        const str = decodeText(v, pos + 2, actLen, this.encoding);
        strings.push(str);
        pos += maxLen + 2;
      } while (pos < v.length);
      this.value = strings;
      this.quality = PlcTagQC.TAG_QUALITY_GOOD;
    } else {
      this.quality = PlcTagQC.TAG_QUALITY_BAD;
    }
  }

  getWriteValue(): PValue {
    const byteStrings: number[] = [];
    for (const item of this.value) {
      // Must write the complete array of MaxLength of the string (plus two bytes header).
      const sb = encodeText(item, this.encoding);
      const b = new Uint8Array(this.maxLength + 2);
      b[0] = this.maxLength;
      b[1] = sb.length;
      for (let i = 0; i < sb.length; i++) {
        b[i + 2] = sb[i];
      }
      byteStrings.push(...b);
    }
    return new ValueUSIntArray(new Uint8Array(byteStrings));
  }

  setStringEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  override toString(): string {
    let s = '<Value type ="StringArray" size="' + this.value.length.toString() + '">';
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return PlcTag.resultString(this, s);
  }
}

// #endregion
