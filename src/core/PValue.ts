/******************************************************************************
 * S7CommPlusDriver
 *
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 *
 * This file is part of S7CommPlusDriver.
 *
 * S7CommPlusDriver is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * Ported to TypeScript.
 ****************************************************************************/

import { ByteStream } from "./ByteStream.js";
import { Datatype } from "./Datatype.js";
import type { IS7pSerialize } from "./IS7pSerialize.js";
import { S7p } from "./S7p.js";
import { doubleToString, singleToString } from "./NetCompat.js";

// Mimics Dictionary.Add, which throws on duplicate keys.
function addUnique<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) throw new Error("An item with the same key has already been added.");
  map.set(key, value);
}

/**
 * C# `new T[n]` with a uint `n` throws OverflowException / OutOfMemoryException for absurd sizes read from a (corrupt)
 * telegram. A JS `new Array(n)` would silently create a huge sparse array and then loop for ~4G iterations,
 * so mimic the C# behaviour and throw (max .NET array length is 0x7FFFFFC7).
 */
function arrayLen(n: number): number {
  if (n > 0x7fffffc7) throw new RangeError("Arithmetic operation resulted in an overflow.");
  return n;
}

function pad(n: number | bigint, width: number): string {
  return n.toString().padStart(width, "0");
}

// TODO: Maybe there's room for improvement, as the array classes duplicate many code of the base classes
export abstract class PValue implements IS7pSerialize {
  static readonly FLAGS_ARRAY = 0x10;
  static readonly FLAGS_ADDRESSARRAY = 0x20;
  static readonly FLAGS_SPARSEARRAY = 0x40;

  protected datatypeFlags = 0;

  abstract serialize(buffer: ByteStream): number;

  isArray(): boolean {
    return (this.datatypeFlags & PValue.FLAGS_ARRAY) !== 0;
  }

  isAddressArray(): boolean {
    return (this.datatypeFlags & PValue.FLAGS_ADDRESSARRAY) !== 0;
  }

  isSparseArray(): boolean {
    return (this.datatypeFlags & PValue.FLAGS_SPARSEARRAY) !== 0;
  }

  /**
   * Deserializes the buffer to the protocol values
   * @param buffer Stream of bytes from the network
   * @param disableVlq If true, the variable length encoding is disabled for all underlying values (so far only neccessary on SystemEvent)
   * @returns The protocol value (null for unknown datatypes, like the C# original)
   */
  static deserialize(buffer: ByteStream, disableVlq = false): PValue | null {
    let flags: number;
    let datatype: number;

    if (!disableVlq) {
      flags = S7p.decodeByte(buffer);
      datatype = S7p.decodeByte(buffer);
    } else {
      // If VLQ is disabled, there are two additional bytes we just skip here.
      S7p.decodeByte(buffer);
      flags = S7p.decodeByte(buffer);
      S7p.decodeByte(buffer);
      datatype = S7p.decodeByte(buffer);
    }

    // Sparsearray and Addressarray of Struct are different
    if (flags === PValue.FLAGS_ARRAY || flags === PValue.FLAGS_ADDRESSARRAY) {
      switch (datatype) {
        case Datatype.Bool:
          return ValueBoolArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.USInt:
          return ValueUSIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.UInt:
          return ValueUIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.UDInt:
          return ValueUDIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.ULInt:
          return ValueULIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.SInt:
          return ValueSIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Int:
          return ValueIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.DInt:
          return ValueDIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.LInt:
          return ValueLIntArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Byte:
          return ValueByteArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Word:
          return ValueWordArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.DWord:
          return ValueDWordArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.LWord:
          return ValueLWordArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Real:
          return ValueRealArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.LReal:
          return ValueLRealArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Timestamp:
          return ValueTimestampArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Timespan:
          return ValueTimespanArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.RID:
          return ValueRIDArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.AID:
          return ValueAIDArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Blob:
          return ValueBlobArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.WString:
          return ValueWStringArray.deserializeBody(buffer, flags, disableVlq);
        default:
          throw new Error("NotImplemented");
      }
    } else if (flags === PValue.FLAGS_SPARSEARRAY) {
      switch (datatype) {
        case Datatype.DInt:
          return ValueDIntSparseArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.UDInt:
          return ValueUDIntSparseArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Blob:
          return ValueBlobSparseArray.deserializeBody(buffer, flags, disableVlq);
        case Datatype.WString:
          return ValueWStringSparseArray.deserializeBody(buffer, flags, disableVlq);
        default:
          throw new Error("NotImplemented");
      }
    } else {
      switch (datatype) {
        case Datatype.Null:
          return ValueNull.deserializeBody(buffer, flags);
        case Datatype.Bool:
          return ValueBool.deserializeBody(buffer, flags);
        case Datatype.USInt:
          return ValueUSInt.deserializeBody(buffer, flags);
        case Datatype.UInt:
          return ValueUInt.deserializeBody(buffer, flags);
        case Datatype.UDInt:
          return ValueUDInt.deserializeBody(buffer, flags, disableVlq);
        case Datatype.ULInt:
          return ValueULInt.deserializeBody(buffer, flags, disableVlq);
        case Datatype.SInt:
          return ValueSInt.deserializeBody(buffer, flags);
        case Datatype.Int:
          return ValueInt.deserializeBody(buffer, flags);
        case Datatype.DInt:
          return ValueDInt.deserializeBody(buffer, flags, disableVlq);
        case Datatype.LInt:
          return ValueLInt.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Byte:
          return ValueByte.deserializeBody(buffer, flags);
        case Datatype.Word:
          return ValueWord.deserializeBody(buffer, flags);
        case Datatype.DWord:
          return ValueDWord.deserializeBody(buffer, flags);
        case Datatype.LWord:
          return ValueLWord.deserializeBody(buffer, flags);
        case Datatype.Real:
          return ValueReal.deserializeBody(buffer, flags);
        case Datatype.LReal:
          return ValueLReal.deserializeBody(buffer, flags);
        case Datatype.Timestamp:
          return ValueTimestamp.deserializeBody(buffer, flags);
        case Datatype.Timespan:
          return ValueTimespan.deserializeBody(buffer, flags, disableVlq);
        case Datatype.RID:
          return ValueRID.deserializeBody(buffer, flags);
        case Datatype.AID:
          return ValueAID.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Blob:
          return ValueBlob.deserializeBody(buffer, flags, disableVlq);
        case Datatype.WString:
          return ValueWString.deserializeBody(buffer, flags, disableVlq);
        case Datatype.Variant:
          throw new Error("NotImplemented");
        case Datatype.Struct:
          return ValueStruct.deserializeBody(buffer, flags, disableVlq);
        case Datatype.S7String:
          throw new Error("NotImplemented");
      }
    }
    return null;
  }
}

export class ValueNull extends PValue {
  constructor(flags = 0) {
    super();
    this.datatypeFlags = flags;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Null);
    return ret;
  }

  override toString(): string {
    return "<Value type=\"Null\"></Value>";
  }

  static deserializeBody(_buffer: ByteStream, flags: number): ValueNull {
    return new ValueNull(flags);
  }
}

export class ValueBool extends PValue {
  private value: boolean;

  constructor(value: boolean, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): boolean {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Bool);
    ret += S7p.encodeByte(buffer, this.value ? 1 : 0);
    return ret;
  }

  override toString(): string {
    return `<Value type="Bool">${(this.value ? "True" : "False")}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueBool {
    const value = S7p.decodeByte(buffer) !== 0;
    return new ValueBool(value, flags);
  }
}

export class ValueBoolArray extends PValue {
  private value!: boolean[];

  constructor(value: boolean[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): boolean[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Bool);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeByte(buffer, this.value[i] ? 1 : 0);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"BoolArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${(this.value[i] ? "True" : "False")}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueBoolArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<boolean>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeByte(buffer) !== 0;
    }
    return new ValueBoolArray(value, flags);
  }
}

export class ValueUSInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.USInt);
    ret += S7p.encodeByte(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="USInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueUSInt {
    const value = S7p.decodeByte(buffer);
    return new ValueUSInt(value, flags);
  }
}

export class ValueUSIntArray extends PValue {
  private value!: Uint8Array;

  constructor(value: Uint8Array, flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): Uint8Array {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.USInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeByte(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"USIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueUSIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Uint8Array(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeByte(buffer);
    }
    return new ValueUSIntArray(value, flags);
  }
}

export class ValueUInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.UInt);
    ret += S7p.encodeUInt16(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="UInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueUInt {
    const value = S7p.decodeUInt16(buffer);
    return new ValueUInt(value, flags);
  }
}

export class ValueUIntArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.UInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt16(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"UIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueUIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt16(buffer);
    }
    return new ValueUIntArray(value, flags);
  }
}

export class ValueUDInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.UDInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="UDInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueUDInt {
    const value = disableVlq ? S7p.decodeUInt32(buffer) : S7p.decodeUInt32Vlq(buffer);
    return new ValueUDInt(value, flags);
  }
}

export class ValueUDIntArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.UDInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt32Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"UDIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueUDIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeUInt32(buffer) : S7p.decodeUInt32Vlq(buffer);
    }
    return new ValueUDIntArray(value, flags);
  }
}

// The construction of Sparsearray is almost similar to reading a struct.
// All elements are kind of key,value. And Value is of the selected type.
// The list is terminated by Null.
// E.g.: Reading 1037 (SystemLimits) via GetVarSubStreamed
export class ValueUDIntSparseArray extends PValue {
  private value!: Map<number, number>;

  constructor(value: Map<number, number>, flags: number = PValue.FLAGS_SPARSEARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = new Map(value);
    }
  }

  getValue(): Map<number, number> {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.UDInt);
    for (const [k, v] of this.value) {
      ret += S7p.encodeUInt32Vlq(buffer, k);
      ret += S7p.encodeUInt32Vlq(buffer, v);
    }
    ret += S7p.encodeByte(buffer, 0);
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"UDIntSparseArray\">";
    for (const [k, v] of this.value) {
      s += `<Value key="${k}">${v}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueUDIntSparseArray {
    const value = new Map<number, number>();
    let k: number;
    let v: number;
    if (!disableVlq) {
      k = S7p.decodeUInt32Vlq(buffer);
      while (k > 0) {
        v = S7p.decodeUInt32Vlq(buffer);
        addUnique(value, k, v);
        k = S7p.decodeUInt32Vlq(buffer);
      }
    } else {
      k = S7p.decodeUInt32(buffer);
      while (k > 0) {
        v = S7p.decodeUInt32(buffer);
        addUnique(value, k, v);
        k = S7p.decodeUInt32(buffer);
      }
    }
    return new ValueUDIntSparseArray(value, flags);
  }
}

export class ValueULInt extends PValue {
  private value: bigint;

  constructor(value: bigint, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): bigint {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.ULInt);
    ret += S7p.encodeUInt64Vlq(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="ULInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueULInt {
    const value = disableVlq ? S7p.decodeUInt64(buffer) : S7p.decodeUInt64Vlq(buffer);
    return new ValueULInt(value, flags);
  }
}

export class ValueULIntArray extends PValue {
  private value!: bigint[];

  constructor(value: bigint[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): bigint[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.ULInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt64Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"ULIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueULIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<bigint>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeUInt64(buffer) : S7p.decodeUInt64Vlq(buffer);
    }
    return new ValueULIntArray(value, flags);
  }
}

export class ValueSInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.SInt);
    ret += S7p.encodeByte(buffer, this.value & 0xff);
    return ret;
  }

  override toString(): string {
    return `<Value type="SInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueSInt {
    const value = (S7p.decodeByte(buffer) << 24) >> 24;
    return new ValueSInt(value, flags);
  }
}

export class ValueSIntArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.SInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeByte(buffer, this.value[i] & 0xff);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"SIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueSIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = (S7p.decodeByte(buffer) << 24) >> 24;
    }
    return new ValueSIntArray(value, flags);
  }
}

export class ValueInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Int);
    ret += S7p.encodeInt16(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="Int">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueInt {
    const value = S7p.decodeInt16(buffer);
    return new ValueInt(value, flags);
  }
}

export class ValueIntArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Int);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeInt16(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"IntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeInt16(buffer);
    }
    return new ValueIntArray(value, flags);
  }
}

export class ValueDInt extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.DInt);
    ret += S7p.encodeInt32Vlq(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="DInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueDInt {
    const value = disableVlq ? S7p.decodeInt32(buffer) : S7p.decodeInt32Vlq(buffer);
    return new ValueDInt(value, flags);
  }
}

export class ValueDIntArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.DInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeInt32Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"DIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueDIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeInt32(buffer) : S7p.decodeInt32Vlq(buffer);
    }
    return new ValueDIntArray(value, flags);
  }
}

// The construction of Sparsearray is almost similar to reading a struct.
// All elements are kind of key,value. And Value is of the selected type.
// The list is terminated by Null.
// E.g.: Reading 1037 (SystemLimits) via GetVarSubStreamed
export class ValueDIntSparseArray extends PValue {
  private value!: Map<number, number>;

  constructor(value: Map<number, number>, flags: number = PValue.FLAGS_SPARSEARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = new Map(value);
    }
  }

  getValue(): Map<number, number> {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.DInt);
    for (const [k, v] of this.value) {
      ret += S7p.encodeUInt32Vlq(buffer, k);
      ret += S7p.encodeInt32Vlq(buffer, v);
    }
    ret += S7p.encodeByte(buffer, 0);
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"DIntSparseArray\">";
    for (const [k, v] of this.value) {
      s += `<Value key="${k}">${v}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueDIntSparseArray {
    const value = new Map<number, number>();
    let k: number;
    let v: number;
    if (!disableVlq) {
      k = S7p.decodeUInt32Vlq(buffer);
      while (k > 0) {
        v = S7p.decodeInt32Vlq(buffer);
        addUnique(value, k, v);
        k = S7p.decodeUInt32Vlq(buffer);
      }
    } else {
      k = S7p.decodeUInt32(buffer);
      while (k > 0) {
        v = S7p.decodeInt32(buffer);
        addUnique(value, k, v);
        k = S7p.decodeUInt32(buffer);
      }
    }
    return new ValueDIntSparseArray(value, flags);
  }
}

export class ValueLInt extends PValue {
  private value: bigint;

  constructor(value: bigint, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): bigint {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LInt);
    ret += S7p.encodeInt64Vlq(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="LInt">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueLInt {
    const value = disableVlq ? S7p.decodeInt64(buffer) : S7p.decodeInt64Vlq(buffer);
    return new ValueLInt(value, flags);
  }
}

export class ValueLIntArray extends PValue {
  private value!: bigint[];

  constructor(value: bigint[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): bigint[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LInt);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeInt64Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"LIntArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueLIntArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<bigint>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeInt64(buffer) : S7p.decodeInt64Vlq(buffer);
    }
    return new ValueLIntArray(value, flags);
  }
}

export class ValueByte extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Byte);
    ret += S7p.encodeByte(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="Byte">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueByte {
    const value = S7p.decodeByte(buffer);
    return new ValueByte(value, flags);
  }
}

export class ValueByteArray extends PValue {
  private value!: Uint8Array;

  constructor(value: Uint8Array, flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): Uint8Array {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Byte);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeByte(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"ByteArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueByteArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Uint8Array(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeByte(buffer);
    }
    return new ValueByteArray(value, flags);
  }
}

export class ValueWord extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Word);
    ret += S7p.encodeUInt16(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="Word">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueWord {
    const value = S7p.decodeUInt16(buffer);
    return new ValueWord(value, flags);
  }
}

export class ValueWordArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Word);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt16(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"WordArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueWordArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt16(buffer);
    }
    return new ValueWordArray(value, flags);
  }
}

export class ValueDWord extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.DWord);
    ret += S7p.encodeUInt32(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="DWord">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueDWord {
    const value = S7p.decodeUInt32(buffer);
    return new ValueDWord(value, flags);
  }
}

export class ValueDWordArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.DWord);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt32(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"DWordArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueDWordArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt32(buffer);
    }
    return new ValueDWordArray(value, flags);
  }
}

export class ValueLWord extends PValue {
  private value: bigint;

  constructor(value: bigint, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): bigint {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LWord);
    ret += S7p.encodeUInt64(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="LWord">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueLWord {
    const value = S7p.decodeUInt64(buffer);
    return new ValueLWord(value, flags);
  }
}

export class ValueLWordArray extends PValue {
  private value!: bigint[];

  constructor(value: bigint[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): bigint[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LWord);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt64(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"LWordArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueLWordArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<bigint>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt64(buffer);
    }
    return new ValueLWordArray(value, flags);
  }
}

export class ValueReal extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Real);
    ret += S7p.encodeFloat(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="Real">${singleToString(this.value)}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueReal {
    const value = S7p.decodeFloat(buffer);
    return new ValueReal(value, flags);
  }
}

export class ValueRealArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Real);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeFloat(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"RealArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${singleToString(this.value[i])}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueRealArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeFloat(buffer);
    }
    return new ValueRealArray(value, flags);
  }
}

export class ValueLReal extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LReal);
    ret += S7p.encodeDouble(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="LReal">${doubleToString(this.value)}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueLReal {
    const value = S7p.decodeDouble(buffer);
    return new ValueLReal(value, flags);
  }
}

export class ValueLRealArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LReal);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeDouble(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"LRealArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${doubleToString(this.value[i])}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueLRealArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeDouble(buffer);
    }
    return new ValueLRealArray(value, flags);
  }
}

export class ValueTimestamp extends PValue {
  private value: bigint;

  constructor(value: bigint, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): bigint {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Timestamp);
    ret += S7p.encodeUInt64(buffer, this.value);
    return ret;
  }

  static toStringValue(value: bigint): string {
    const NS_PER_S = 1000000000n;
    let ns = value % NS_PER_S;
    const secs = value / NS_PER_S;

    // Epoch 1970-01-01 plus seconds, formatted like .NET DateTime.ToString() (invariant: MM/dd/yyyy HH:mm:ss)
    const d = new Date(Number(secs) * 1000);
    const dt =
      pad(d.getUTCMonth() + 1, 2) + "/" + pad(d.getUTCDate(), 2) + "/" + pad(d.getUTCFullYear(), 4) + " " +
      pad(d.getUTCHours(), 2) + ":" + pad(d.getUTCMinutes(), 2) + ":" + pad(d.getUTCSeconds(), 2);

    if (ns % 1000n > 0n) {
      return `${dt}.${pad(ns, 9)}`;
    } else if (ns % 1000000n > 0n) {
      ns /= 1000n;
      return `${dt}.${pad(ns, 6)}`;
    } else if (ns % 1000000000n > 0n) {
      ns /= 1000000n;
      return `${dt}.${pad(ns, 3)}`;
    }
    return dt;
  }

  override toString(): string {
    const str = ValueTimestamp.toStringValue(this.value);
    return "<Value type=\"Timestamp\">" + str + "</Value>";
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueTimestamp {
    const value = S7p.decodeUInt64(buffer);
    return new ValueTimestamp(value, flags);
  }
}

export class ValueTimestampArray extends PValue {
  private value!: bigint[];

  constructor(value: bigint[], flags: number = 0) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value;
    }
  }

  getValue(): bigint[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Timestamp);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt64(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"TimestampArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${ValueTimestamp.toStringValue(this.value[i])}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueTimestampArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<bigint>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt64(buffer);
    }
    return new ValueTimestampArray(value, flags);
  }
}

export class ValueTimespan extends PValue {
  private value: bigint;

  constructor(value: bigint, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): bigint {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Timespan);
    ret += S7p.encodeInt64Vlq(buffer, this.value);
    return ret;
  }

  static toStringValue(value: bigint): string {
    const divs: bigint[] = [86400000000000n, 3600000000000n, 60000000000n, 1000000000n, 1000000n, 1000n, 1n];
    const vfmt: ((v: number) => string)[] = [
      (v) => `${v}d`,
      (v) => `${pad(v, 2)}h`,
      (v) => `${pad(v, 2)}m`,
      (v) => `${pad(v, 2)}s`,
      (v) => `${pad(v, 3)}ms`,
      (v) => `${pad(v, 3)}us`,
      (v) => `${pad(v, 3)}ns`,
    ];
    let str: string;
    let timespan = value;
    let timeNegative = false;
    if (timespan === 0n) {
      str = "LT#000ns";
    } else {
      if (timespan < 0n) {
        str = "LT#-";
        timeNegative = true;
        for (let i = 0; i < 7; i++) {
          divs[i] = -divs[i];
        }
      } else {
        str = "LT#";
      }

      for (let i = 0; i < 7; i++) {
        const val = timespan / divs[i];
        timespan -= val * divs[i];
        if (val > 0n) {
          str += vfmt[i](Number(BigInt.asIntN(32, val)));
          if ((!timeNegative && timespan > 0n) || (timeNegative && timespan < 0n)) {
            str += "_";
          }
        }
      }
    }
    return str;
  }

  override toString(): string {
    const str = ValueTimespan.toStringValue(this.value);
    return "<Value type=\"Timespan\">" + str + "</Value>";
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueTimespan {
    const value = disableVlq ? S7p.decodeInt64(buffer) : S7p.decodeInt64Vlq(buffer);
    return new ValueTimespan(value, flags);
  }
}

export class ValueTimespanArray extends PValue {
  private value!: bigint[];

  constructor(value: bigint[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): bigint[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.LReal);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeInt64Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"ValueTimespanArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${ValueTimespan.toStringValue(this.value[i])}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueTimespanArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<bigint>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeInt64(buffer) : S7p.decodeInt64Vlq(buffer);
    }
    return new ValueTimespanArray(value, flags);
  }
}

export class ValueRID extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.RID);
    ret += S7p.encodeUInt32(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="RID">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number): ValueRID {
    const value = S7p.decodeUInt32(buffer);
    return new ValueRID(value, flags);
  }
}

export class ValueRIDArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.RID);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt32(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"RIDArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueRIDArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = S7p.decodeUInt32(buffer);
    }
    return new ValueRIDArray(value, flags);
  }
}

export class ValueAID extends PValue {
  private value: number;

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.AID);
    ret += S7p.encodeUInt32Vlq(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return `<Value type="AID">${this.value}</Value>`;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueAID {
    const value = disableVlq ? S7p.decodeUInt32(buffer) : S7p.decodeUInt32Vlq(buffer);
    return new ValueAID(value, flags);
  }
}

export class ValueAIDArray extends PValue {
  private value!: number[];

  constructor(value: number[], flags: number = PValue.FLAGS_ARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): number[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.AID);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt32Vlq(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"AIDArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueAIDArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<number>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = disableVlq ? S7p.decodeUInt32(buffer) : S7p.decodeUInt32Vlq(buffer);
    }
    return new ValueAIDArray(value, flags);
  }
}

function bytesToHex(b: Uint8Array): string {
  // Like BitConverter.ToString: "AA-BB-CC"
  return Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, "0")).join("-");
}

export class ValueBlob extends PValue {
  blobRootId: number;
  private value!: Uint8Array;

  hasBlobType = false; // Special
  blobType = 0; // Special

  constructor(blobRootId: number, value: Uint8Array | null, flags = 0) {
    super();
    this.blobRootId = blobRootId;
    this.datatypeFlags = flags;
    // A blob with size zero is allowed and no error.
    if (value != null) {
      this.value = value.slice();
    }
  }

  /** May be null (blob without data / not enough data on decode, like C#). */
  getValue(): Uint8Array | null {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Blob);
    ret += S7p.encodeUInt32Vlq(buffer, this.blobRootId);
    ret += S7p.encodeUInt32Vlq(buffer, this.value!.length >>> 0);
    ret += S7p.encodeOctets(buffer, this.value);
    return ret;
  }

  override toString(): string {
    let s: string;
    if (!this.hasBlobType) {
      s = "<Value type=\"Blob\" BlobRootId=\"" + this.blobRootId.toString() + "\">";
    } else {
      s = "<Value type=\"Blob\" BlobRootId=\"" + this.blobRootId.toString() + "\" BlobType=\"" + this.blobType.toString() + "\">";
    }
    if (this.value != null) {
      s += bytesToHex(this.value);
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueBlob {
    let hasBlobType = false;
    let blobType = 0;
    const blobRootId = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    // Special handling:
    // If first value > 1 then special format with 8 additional bytes + 1 type-id + value.
    // On HMI project transfer this occurs with ID=1 (as SubStream) but without the extra bytes.
    // Used for example in Alarm Notifications for the AssociatedValues.
    if (blobRootId > 1) {
      hasBlobType = true;
      S7p.decodeUInt64(buffer); // Don't use it for now. All bytes were zero so far.
      blobType = S7p.decodeByte(buffer);
      // - If BlobType value == 0x02 or 0x03, then follows a length specification and the number of bytes.
      //   This is used in alarms and the associated values inside the blob-array.
      // - If BlobType value == 0x00, then follows an ID/value list.
      //   This is used in program transfer.
      switch (blobType) {
        case 0x02:
        case 0x03:
          // handling below is the same from here
          break;
        default:
          // can't handle this for now, this is completely different...
          throw new Error("NotImplemented");
      }
    }

    const blobSize = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    arrayLen(blobSize); // C#: value = new byte[blobSize]
    const value = S7p.decodeOctets(buffer, blobSize);
    const blob = new ValueBlob(blobRootId, value, flags);
    blob.hasBlobType = hasBlobType;
    blob.blobType = blobType;
    return blob;
  }
}

export class ValueBlobArray extends PValue {
  private value!: ValueBlob[];

  constructor(value: ValueBlob[], flags: number = PValue.FLAGS_ADDRESSARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = value.slice();
    }
  }

  getValue(): ValueBlob[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Blob);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += this.value[i].serialize(buffer);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"ValueBlobArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i].toString()}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueBlobArray {
    const size = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = new Array<ValueBlob>(arrayLen(size));
    for (let i = 0; i < size; i++) {
      value[i] = ValueBlob.deserializeBody(buffer, flags, disableVlq);
    }
    return new ValueBlobArray(value, flags);
  }
}

export interface BlobEntry {
  blobRootId: number;
  value: Uint8Array | null;
}

export class ValueBlobSparseArray extends PValue {
  value!: Map<number, BlobEntry>;

  constructor(value: Map<number, BlobEntry>, flags: number = PValue.FLAGS_SPARSEARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = new Map(value);
    }
  }

  getValue(): Map<number, BlobEntry> {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Blob);
    for (const [k, v] of this.value) {
      ret += S7p.encodeUInt32Vlq(buffer, k);
      ret += S7p.encodeUInt32Vlq(buffer, v.blobRootId);
      ret += S7p.encodeUInt32Vlq(buffer, v.value!.length >>> 0);
      ret += S7p.encodeOctets(buffer, v.value);
    }
    ret += S7p.encodeByte(buffer, 0);
    return ret;
  }

  override toString(): string {
    let s = "<Value type=\"BlobSparseArray\">";
    for (const [k, v] of this.value) {
      s += `<Value key="${k}" BlobRootId="${v.blobRootId}">`;
      if (this.value != null && v.value != null) {
        s += bytesToHex(v.value);
      }
      s += "</Value>";
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueBlobSparseArray {
    const value = new Map<number, BlobEntry>();
    const rd = disableVlq ? (b: ByteStream) => S7p.decodeUInt32(b) : (b: ByteStream) => S7p.decodeUInt32Vlq(b);
    let k = rd(buffer);
    while (k > 0) {
      const blobRootId = rd(buffer);
      const blobSize = rd(buffer);
      arrayLen(blobSize); // C#: v.value = new byte[blobSize]
      const v: BlobEntry = { blobRootId, value: S7p.decodeOctets(buffer, blobSize) };
      addUnique(value, k, v);
      k = rd(buffer);
    }
    return new ValueBlobSparseArray(value, flags);
  }
}

export class ValueWString extends PValue {
  private value: string;

  constructor(value: string, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.WString);
    ret += S7p.encodeUInt32Vlq(buffer, new TextEncoder().encode(this.value).length); // UTF-8 byte length (C# original used char count, wrong for non-ASCII)
    ret += S7p.encodeWString(buffer, this.value);
    return ret;
  }

  override toString(): string {
    return "<Value type=\"WString\">" + this.value + "</Value>";
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueWString {
    const stringlen = !disableVlq ? S7p.decodeUInt32Vlq(buffer) : S7p.decodeUInt32(buffer);
    const value = S7p.decodeWString(buffer, stringlen);
    return new ValueWString(value, flags);
  }
}

export class ValueWStringArray extends PValue {
  private value!: string[];

  constructor(value: string[], flags: number = PValue.FLAGS_ADDRESSARRAY) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
  }

  getValue(): string[] {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.WString);
    ret += S7p.encodeUInt32Vlq(buffer, this.value.length >>> 0);
    for (let i = 0; i < this.value.length; i++) {
      ret += S7p.encodeUInt32Vlq(buffer, this.value[i].length >>> 0);
      ret += S7p.encodeWString(buffer, this.value[i]);
    }
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"WStringArray\" size=\"" + this.value.length.toString() + "\">";
    for (let i = 0; i < this.value.length; i++) {
      s += `<Value>${this.value[i]}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueWStringArray {
    const rd = disableVlq ? (b: ByteStream) => S7p.decodeUInt32(b) : (b: ByteStream) => S7p.decodeUInt32Vlq(b);
    const arraySize = rd(buffer);
    const value = new Array<string>(arrayLen(arraySize));
    for (let i = 0; i < arraySize; i++) {
      const stringlen = rd(buffer);
      value[i] = S7p.decodeWString(buffer, stringlen);
    }
    return new ValueWStringArray(value, flags);
  }
}

export class ValueWStringSparseArray extends PValue {
  private value!: Map<number, string>;

  constructor(value: Map<number, string>, flags: number = PValue.FLAGS_SPARSEARRAY) {
    super();
    this.datatypeFlags = flags;
    if (value != null) {
      this.value = new Map(value);
    }
  }

  getValue(): Map<number, string> {
    return this.value;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.WString);
    for (const [k, v] of this.value) {
      ret += S7p.encodeUInt32Vlq(buffer, k);
      ret += S7p.encodeUInt32Vlq(buffer, v.length >>> 0);
      ret += S7p.encodeWString(buffer, v);
    }
    ret += S7p.encodeByte(buffer, 0);
    return ret;
  }

  override toString(): string {
    let s = "<Value type =\"WStringSparseArray\">";
    for (const [k, v] of this.value) {
      s += `<Value key="${k}">${v}</Value>`;
    }
    s += "</Value>";
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq: boolean): ValueWStringSparseArray {
    const value = new Map<number, string>();
    const rd = disableVlq ? (b: ByteStream) => S7p.decodeUInt32(b) : (b: ByteStream) => S7p.decodeUInt32Vlq(b);
    let k = rd(buffer);
    while (k > 0) {
      const stringlen = rd(buffer);
      const v = S7p.decodeWString(buffer, stringlen);
      addUnique(value, k, v);
      k = rd(buffer);
    }
    return new ValueWStringSparseArray(value, flags);
  }
}

export const PackedStructTransportFlagBits = {
  None: 0,
  ClassicNonoptimizedOffsets: 1 << 0, // Is set when a struct is read from non-optimized datablock
  AlwaysSet: 1 << 1, // Is (so far) always set
  Count2Present: 1 << 10, // If this bit is set, then there's a 2nd counter present. Which if for a rare case you can read an array of struct, if the complete size, the 1st for one element.
} as const;
export type PackedStructTransportFlagBits = (typeof PackedStructTransportFlagBits)[keyof typeof PackedStructTransportFlagBits];

function isPackedStructId(value: number): boolean {
  return (value > 0x90000000 && value < 0x9fffffff) || (value > 0x02000000 && value < 0x02ffffff);
}

export class ValueStruct extends PValue {
  /** Same as C# nested enum ValueStruct.PackedStructTransportFlagBits */
  static readonly PackedStructTransportFlagBits = PackedStructTransportFlagBits;

  private value: number;
  private elements = new Map<number, PValue>();
  /**
   * InterfaceTimestamp: Only relevant if Value is transmitted as Packed Struct.
   * Used on transmitting Systemdatatypes in a compact way (e.g. DTL).
   */
  packedStructInterfaceTimestamp = 0n;
  packedStructTransportFlags: number = PackedStructTransportFlagBits.AlwaysSet; // Use 2 as standard value (probably a bitfield)

  constructor(value: number, flags = 0) {
    super();
    this.datatypeFlags = flags;
    this.value = value;
    this.elements = new Map<number, PValue>();
  }

  getValue(): number {
    return this.value;
  }

  addStructElement(id: number, elem: PValue): void {
    addUnique(this.elements, id, elem);
  }

  getStructElement(id: number): PValue {
    const e = this.elements.get(id);
    if (e === undefined) throw new Error("The given key was not present in the dictionary.");
    return e;
  }

  override serialize(buffer: ByteStream): number {
    let ret = 0;

    ret += S7p.encodeByte(buffer, this.datatypeFlags);
    ret += S7p.encodeByte(buffer, Datatype.Struct);
    ret += S7p.encodeUInt32(buffer, this.value);
    // TODO: EXPERIMENTAL!
    // Packed Struct, see comment in Deserialize
    if (isPackedStructId(this.value)) {
      // There should be only one Element? The key from the dictionary element is not used.
      // It's somewhat all hacked into the Struct variant...
      for (const [, elem] of this.elements) {
        // The timestamp must be exactly the same as from browsing the Plc, otherwise we
        // get an Error "InvalidTimestampInTypeSafeBlob"
        ret += S7p.encodeUInt64(buffer, this.packedStructInterfaceTimestamp);

        ret += S7p.encodeUInt32Vlq(buffer, this.packedStructTransportFlags);

        if (elem instanceof ValueByteArray) {
          const barr = elem.getValue();
          const elementcount = barr.length >>> 0;
          ret += S7p.encodeUInt32Vlq(buffer, elementcount);
          // Don't use the Serialize method of ValueByteArray, because there is an additional header we don't want here.
          for (let i = 0; i < barr.length; i++) {
            ret += S7p.encodeByte(buffer, barr[i]);
          }
        } else {
          console.log("ValueStruct.Serialize(): Elements[0] is not of type ValueByteArray");
        }
      }
    } else {
      for (const [key, elem] of this.elements) {
        ret += S7p.encodeUInt32Vlq(buffer, key);
        ret += elem.serialize(buffer);
      }
      ret += S7p.encodeByte(buffer, 0); // List Terminator
    }
    return ret;
  }

  override toString(): string {
    const nl = "\n";
    let s = "";
    s += "<Value type =\"Struct\">" + nl;
    s += "<ID>" + this.value.toString() + "</ID>" + nl;
    if (isPackedStructId(this.value)) {
      s += "<PackedStructInterfaceTimestamp>" + this.packedStructInterfaceTimestamp.toString() + "</PackedStructInterfaceTimestamp>" + nl;
      s += "<PackedStructTransportFlags>" + this.packedStructTransportFlags.toString() + "</PackedStructTransportFlags>" + nl;
    }
    for (const [key, elem] of this.elements) {
      s += "<Element>" + nl;
      s += "<ID>" + key.toString() + "</ID>" + nl;
      s += elem.toString() + nl;
      s += "</Element>" + nl;
    }
    s += "</Value>" + nl;
    return s;
  }

  static deserializeBody(buffer: ByteStream, flags: number, disableVlq = false): ValueStruct {
    let value = S7p.decodeUInt32(buffer);
    let stru: ValueStruct;

    // Special handling of datatype struct and some specific ID ranges:
    // Some struct elements aren't transmitted as single elements. Instead they are packed (e.g. DTL-Struct).
    // The ID number range where this is used is only guessed (Type Info).
    if (isPackedStructId(value)) {
      // Packed Struct
      // These are system datatypes. Either the information about them must be read out of the CPU before,
      // or must be known before. As the data are transmitted as Bytearrays, return them in this type. Interpretation must be done later.
      stru = new ValueStruct(value, flags);

      stru.packedStructInterfaceTimestamp = S7p.decodeUInt64(buffer);
      let transpFlags: number;
      let elementcount: number;
      if (!disableVlq) {
        transpFlags = S7p.decodeUInt32Vlq(buffer);
        elementcount = S7p.decodeUInt32Vlq(buffer);
        if ((transpFlags & PackedStructTransportFlagBits.Count2Present) !== 0) {
          // Here's an additional counter value, for whatever reason...
          elementcount = S7p.decodeUInt32Vlq(buffer);
        }
      } else {
        transpFlags = S7p.decodeUInt32(buffer);
        elementcount = S7p.decodeUInt32(buffer);
        if ((transpFlags & PackedStructTransportFlagBits.Count2Present) !== 0) {
          // Here's an additional counter value, for whatever reason...
          elementcount = S7p.decodeUInt32(buffer);
        }
      }
      stru.packedStructTransportFlags = transpFlags;
      const barr = new Uint8Array(arrayLen(elementcount));
      for (let i = 0; i < elementcount; i++) {
        barr[i] = S7p.decodeByte(buffer);
      }
      const elem = new ValueByteArray(barr);
      stru.addStructElement(value, elem);
    } else {
      stru = new ValueStruct(value, flags);
      if (!disableVlq) {
        value = S7p.decodeUInt32Vlq(buffer);
        while (value > 0) {
          const elem = PValue.deserialize(buffer, disableVlq);
          stru.addStructElement(value, elem as PValue);
          value = S7p.decodeUInt32Vlq(buffer);
        }
      } else {
        value = S7p.decodeUInt32(buffer);
        while (value > 0) {
          const elem = PValue.deserialize(buffer, disableVlq);
          stru.addStructElement(value, elem as PValue);
          value = S7p.decodeUInt32(buffer);
        }
      }
    }
    return stru;
  }
}
