/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { S7p } from "./S7p.js";

const NL = "\n";

export interface IOffsetInfoType_Relation {
  getRelationId(): number;
}

export interface IOffsetInfoType_MDim {
  getArrayLowerBounds(): number;
  getArrayElementCount(): number;
  getMdimArrayLowerBounds(): number[];
  getMdimArrayElementCount(): number[];
}

export interface IOffsetInfoType_1Dim {
  getArrayLowerBounds(): number;
  getArrayElementCount(): number;
}

/**
 * Offsetinfo type for tag description.
 * Values 1..7 are used in old firmware version.
 * TLS supporting firmware version are using 8..15.
 */
export const OffsetInfoType = {
  FbArray: 0,
  StructElemStd: 1,
  StructElemString: 2,
  StructElemArray1Dim: 3,
  StructElemArrayMDim: 4,
  StructElemStruct: 5,
  StructElemStruct1Dim: 6,
  StructElemStructMDim: 7,
  Std: 8,
  String: 9,
  Array1Dim: 10,
  ArrayMDim: 11,
  Struct: 12,
  Struct1Dim: 13,
  StructMDim: 14,
  FbSfb: 15,
} as const;
export type OffsetInfoType = (typeof OffsetInfoType)[keyof typeof OffsetInfoType];

function tag(name: string, value: number): string {
  return "<" + name + ">" + value.toString() + "</" + name + ">" + NL;
}

function mdimTags(lb: number[], ec: number[]): string {
  let s = "";
  for (let d = 0; d < 6; d++) {
    s += "<MdimArrayLowerBounds[" + d + "]>" + lb[d].toString() + "</MdimArrayLowerBounds[" + d + "]>" + NL;
  }
  for (let d = 0; d < 6; d++) {
    s += "<MdimArrayElementCount[" + d + "]>" + ec[d].toString() + "</MdimArrayElementCount[" + d + "]>" + NL;
  }
  return s;
}

export abstract class POffsetInfoType {
  optimizedAddress = 0;
  nonoptimizedAddress = 0;

  abstract hasRelation(): boolean;
  abstract is1Dim(): boolean;
  abstract isMDim(): boolean;

  /** C# `out int length` is returned as `length`; `oi` is null for unknown types. */
  static deserialize(buffer: ByteStream, offsetinfotype: number): { oi: POffsetInfoType | null; length: number } {
    switch (offsetinfotype) {
      case OffsetInfoType.FbArray:
        return POffsetInfoType_FbArray.read(buffer);
      case OffsetInfoType.StructElemStd:
      case OffsetInfoType.Std:
        return POffsetInfoType_Std.read(buffer, offsetinfotype);
      case OffsetInfoType.StructElemString:
      case OffsetInfoType.String:
        return POffsetInfoType_String.read(buffer);
      case OffsetInfoType.StructElemArray1Dim:
      case OffsetInfoType.Array1Dim:
        return POffsetInfoType_Array1Dim.read(buffer);
      case OffsetInfoType.StructElemArrayMDim:
      case OffsetInfoType.ArrayMDim:
        return POffsetInfoType_ArrayMDim.read(buffer);
      case OffsetInfoType.StructElemStruct:
      case OffsetInfoType.Struct:
        return POffsetInfoType_Struct.read(buffer);
      case OffsetInfoType.StructElemStruct1Dim:
      case OffsetInfoType.Struct1Dim:
        return POffsetInfoType_Struct1Dim.read(buffer);
      case OffsetInfoType.StructElemStructMDim:
      case OffsetInfoType.StructMDim:
        return POffsetInfoType_StructMDim.read(buffer);
      case OffsetInfoType.FbSfb:
        return POffsetInfoType_FbSfb.read(buffer);
    }
    return { oi: null, length: 0 };
  }
}

export class POffsetInfoType_FbSfb extends POffsetInfoType implements IOffsetInfoType_Relation {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  relationId = 0;
  info4 = 0;
  info5 = 0;
  info6 = 0;
  info7 = 0;
  retainSectionOffset = 0;
  volatileSectionOffset = 0;

  override hasRelation(): boolean { return true; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_FbSfb; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_FbSfb();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.relationId = S7p.decodeUInt32LE(buffer);
    oi.info4 = S7p.decodeUInt32LE(buffer);
    oi.info5 = S7p.decodeUInt32LE(buffer);
    oi.info6 = S7p.decodeUInt32LE(buffer);
    oi.info7 = S7p.decodeUInt32LE(buffer);
    oi.retainSectionOffset = S7p.decodeUInt32LE(buffer);
    oi.volatileSectionOffset = S7p.decodeUInt32LE(buffer);
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_FbSfb>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("RelationId", this.relationId);
    s += tag("Info4", this.info4);
    s += tag("Info5", this.info5);
    s += tag("Info6", this.info6);
    s += tag("Info7", this.info7);
    s += tag("RetainSectionOffset", this.retainSectionOffset);
    s += tag("VolatileSectionOffset", this.volatileSectionOffset);
    s += "</POffsetInfoType_FbSfb>" + NL;
    return s;
  }

  getRelationId(): number {
    return this.relationId;
  }
}

export class POffsetInfoType_StructMDim extends POffsetInfoType implements IOffsetInfoType_Relation, IOffsetInfoType_MDim {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  arrayLowerBounds = 0;
  arrayElementCount = 0;
  nonoptimizedStructSize = 0;
  optimizedStructSize = 0;
  relationId = 0;
  structInfo4 = 0;
  structInfo5 = 0;
  structInfo6 = 0;
  structInfo7 = 0;
  mdimArrayLowerBounds: number[] = new Array<number>(6).fill(0);
  mdimArrayElementCount: number[] = new Array<number>(6).fill(0);

  override hasRelation(): boolean { return true; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return true; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_StructMDim; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_StructMDim();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.arrayLowerBounds = S7p.decodeInt32LE(buffer);
    oi.arrayElementCount = S7p.decodeUInt32LE(buffer);
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayLowerBounds[d] = S7p.decodeInt32LE(buffer);
    }
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayElementCount[d] = S7p.decodeUInt32LE(buffer);
    }

    oi.nonoptimizedStructSize = S7p.decodeUInt32LE(buffer);
    oi.optimizedStructSize = S7p.decodeUInt32LE(buffer);
    oi.relationId = S7p.decodeUInt32LE(buffer);
    oi.structInfo4 = S7p.decodeUInt32LE(buffer);
    oi.structInfo5 = S7p.decodeUInt32LE(buffer);
    oi.structInfo6 = S7p.decodeUInt32LE(buffer);
    oi.structInfo7 = S7p.decodeUInt32LE(buffer);
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_StructMDim>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("ArrayLowerBounds", this.arrayLowerBounds);
    s += tag("ArrayElementCount", this.arrayElementCount);
    s += mdimTags(this.mdimArrayLowerBounds, this.mdimArrayElementCount);
    s += tag("OptimizedStructSize", this.optimizedStructSize);
    s += tag("NonoptimizedStructSize", this.nonoptimizedStructSize);
    s += tag("RelationId", this.relationId);
    s += tag("StructInfo4", this.structInfo4);
    s += tag("StructInfo5", this.structInfo5);
    s += tag("StructInfo6", this.structInfo6);
    s += tag("StructInfo7", this.structInfo7);
    s += "</POffsetInfoType_StructMDim>" + NL;
    return s;
  }

  getRelationId(): number {
    return this.relationId;
  }

  getArrayLowerBounds(): number {
    return this.arrayLowerBounds;
  }

  getArrayElementCount(): number {
    return this.arrayElementCount;
  }

  getMdimArrayLowerBounds(): number[] {
    return this.mdimArrayLowerBounds;
  }

  getMdimArrayElementCount(): number[] {
    return this.mdimArrayElementCount;
  }
}

export class POffsetInfoType_Struct1Dim extends POffsetInfoType implements IOffsetInfoType_Relation, IOffsetInfoType_1Dim {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  arrayLowerBounds = 0;
  arrayElementCount = 0;
  nonoptimizedStructSize = 0;
  optimizedStructSize = 0;
  relationId = 0;
  structInfo4 = 0;
  structInfo5 = 0;
  structInfo6 = 0;
  structInfo7 = 0;

  override hasRelation(): boolean { return true; }
  override is1Dim(): boolean { return true; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_Struct1Dim; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_Struct1Dim();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.arrayLowerBounds = S7p.decodeInt32LE(buffer);
    oi.arrayElementCount = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedStructSize = S7p.decodeUInt32LE(buffer);
    oi.optimizedStructSize = S7p.decodeUInt32LE(buffer);
    oi.relationId = S7p.decodeUInt32LE(buffer);
    oi.structInfo4 = S7p.decodeUInt32LE(buffer);
    oi.structInfo5 = S7p.decodeUInt32LE(buffer);
    oi.structInfo6 = S7p.decodeUInt32LE(buffer);
    oi.structInfo7 = S7p.decodeUInt32LE(buffer);
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_Struct1Dim>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("ArrayLowerBounds", this.arrayLowerBounds);
    s += tag("ArrayElementCount", this.arrayElementCount);
    s += tag("OptimizedStructSize", this.optimizedStructSize);
    s += tag("NonoptimizedStructSize", this.nonoptimizedStructSize);
    s += tag("RelationId", this.relationId);
    s += tag("StructInfo4", this.structInfo4);
    s += tag("StructInfo5", this.structInfo5);
    s += tag("StructInfo6", this.structInfo6);
    s += tag("StructInfo7", this.structInfo7);
    s += "</POffsetInfoType_Struct1Dim>" + NL;
    return s;
  }

  getRelationId(): number {
    return this.relationId;
  }

  getArrayLowerBounds(): number {
    return this.arrayLowerBounds;
  }

  getArrayElementCount(): number {
    return this.arrayElementCount;
  }
}

export class POffsetInfoType_Struct extends POffsetInfoType implements IOffsetInfoType_Relation {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  relationId = 0;
  structInfo4 = 0;
  structInfo5 = 0;
  structInfo6 = 0;
  structInfo7 = 0;

  override hasRelation(): boolean { return true; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_Struct; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_Struct();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.relationId = S7p.decodeUInt32LE(buffer);
    oi.structInfo4 = S7p.decodeUInt32LE(buffer);
    oi.structInfo5 = S7p.decodeUInt32LE(buffer);
    oi.structInfo6 = S7p.decodeUInt32LE(buffer);
    oi.structInfo7 = S7p.decodeUInt32LE(buffer);
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_Struct>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("RelationId", this.relationId);
    s += tag("StructInfo4", this.structInfo4);
    s += tag("StructInfo5", this.structInfo5);
    s += tag("StructInfo6", this.structInfo6);
    s += tag("StructInfo7", this.structInfo7);
    s += "</POffsetInfoType_Struct>" + NL;
    return s;
  }

  getRelationId(): number {
    return this.relationId;
  }
}

export class POffsetInfoType_ArrayMDim extends POffsetInfoType implements IOffsetInfoType_MDim {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  arrayLowerBounds = 0;
  arrayElementCount = 0;
  mdimArrayLowerBounds: number[] = new Array<number>(6).fill(0);
  mdimArrayElementCount: number[] = new Array<number>(6).fill(0);

  override hasRelation(): boolean { return false; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return true; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_ArrayMDim; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_ArrayMDim();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.arrayLowerBounds = S7p.decodeInt32LE(buffer);
    oi.arrayElementCount = S7p.decodeUInt32LE(buffer);
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayLowerBounds[d] = S7p.decodeInt32LE(buffer);
    }
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayElementCount[d] = S7p.decodeUInt32LE(buffer);
    }

    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_ArrayMDim>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("ArrayLowerBounds", this.arrayLowerBounds);
    s += tag("ArrayElementCount", this.arrayElementCount);
    s += mdimTags(this.mdimArrayLowerBounds, this.mdimArrayElementCount);
    s += "</POffsetInfoType_ArrayMDim>" + NL;
    return s;
  }

  getArrayLowerBounds(): number {
    return this.arrayLowerBounds;
  }

  getArrayElementCount(): number {
    return this.arrayElementCount;
  }

  getMdimArrayLowerBounds(): number[] {
    return this.mdimArrayLowerBounds;
  }

  getMdimArrayElementCount(): number[] {
    return this.mdimArrayElementCount;
  }
}

export class POffsetInfoType_Array1Dim extends POffsetInfoType implements IOffsetInfoType_1Dim {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  arrayLowerBounds = 0;
  arrayElementCount = 0;

  override hasRelation(): boolean { return false; }
  override is1Dim(): boolean { return true; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_Array1Dim; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_Array1Dim();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.arrayLowerBounds = S7p.decodeInt32LE(buffer);
    oi.arrayElementCount = S7p.decodeUInt32LE(buffer);
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_Array1Dim>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("ArrayLowerBounds", this.arrayLowerBounds);
    s += tag("ArrayElementCount", this.arrayElementCount);
    s += "</POffsetInfoType_Array1Dim>" + NL;
    return s;
  }

  getArrayLowerBounds(): number {
    return this.arrayLowerBounds;
  }

  getArrayElementCount(): number {
    return this.arrayElementCount;
  }
}

export class POffsetInfoType_String extends POffsetInfoType {
  unspecifiedOffsetinfo1 = 0;   // This is the max. length of the string
  unspecifiedOffsetinfo2 = 0;   // max. lengh plus 2 bytes stringheader

  override hasRelation(): boolean { return false; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_String; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_String();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_String>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += "</POffsetInfoType_String>" + NL;
    return s;
  }
}

export class POffsetInfoType_FbArray extends POffsetInfoType implements IOffsetInfoType_Relation {
  unspecifiedOffsetinfo1 = 0;
  unspecifiedOffsetinfo2 = 0;
  relationId = 0;
  info4 = 0;
  info5 = 0;
  info6 = 0;
  info7 = 0;
  retainSectionOffset = 0;
  volatileSectionOffset = 0;
  arrayElementCount = 0;
  classicSectionSize = 0;
  retainSectionSize = 0;
  volatileSectionSize = 0;
  mdimArrayLowerBounds: number[] = new Array<number>(6).fill(0);
  mdimArrayElementCount: number[] = new Array<number>(6).fill(0);

  override hasRelation(): boolean { return true; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream): { oi: POffsetInfoType_FbArray; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_FbArray();

    oi.unspecifiedOffsetinfo1 = S7p.decodeUInt16LE(buffer);
    oi.unspecifiedOffsetinfo2 = S7p.decodeUInt16LE(buffer);

    oi.optimizedAddress = S7p.decodeUInt32LE(buffer);
    oi.nonoptimizedAddress = S7p.decodeUInt32LE(buffer);

    oi.relationId = S7p.decodeUInt32LE(buffer);
    oi.info4 = S7p.decodeUInt32LE(buffer);
    oi.info5 = S7p.decodeUInt32LE(buffer);
    oi.info6 = S7p.decodeUInt32LE(buffer);
    oi.info7 = S7p.decodeUInt32LE(buffer);
    oi.retainSectionOffset = S7p.decodeUInt32LE(buffer);
    oi.volatileSectionOffset = S7p.decodeUInt32LE(buffer);
    oi.arrayElementCount = S7p.decodeUInt32LE(buffer);
    oi.classicSectionSize = S7p.decodeUInt32LE(buffer);
    oi.retainSectionSize = S7p.decodeUInt32LE(buffer);
    oi.volatileSectionSize = S7p.decodeUInt32LE(buffer);
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayLowerBounds[d] = S7p.decodeInt32LE(buffer);
    }
    for (let d = 0; d < 6; d++) {
      oi.mdimArrayElementCount[d] = S7p.decodeUInt32LE(buffer);
    }

    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_FbArray>" + NL;
    s += tag("UnspecifiedOffsetinfo1", this.unspecifiedOffsetinfo1);
    s += tag("UnspecifiedOffsetinfo2", this.unspecifiedOffsetinfo2);
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += tag("RelationId", this.relationId);
    s += tag("Info4", this.info4);
    s += tag("Info5", this.info5);
    s += tag("Info6", this.info6);
    s += tag("Info7", this.info7);
    s += tag("RetainSectionOffset", this.retainSectionOffset);
    s += tag("VolatileSectionOffset", this.volatileSectionOffset);
    s += tag("ClassicSectionSize", this.classicSectionSize);
    s += tag("RetainSectionSize", this.retainSectionSize);
    s += tag("VolatileSectionSize", this.volatileSectionSize);
    s += mdimTags(this.mdimArrayLowerBounds, this.mdimArrayElementCount);
    s += "</POffsetInfoType_FbArray>" + NL;
    return s;
  }

  getRelationId(): number {
    return this.relationId;
  }
}

export class POffsetInfoType_Std extends POffsetInfoType {
  override hasRelation(): boolean { return false; }
  override is1Dim(): boolean { return false; }
  override isMDim(): boolean { return false; }

  static read(buffer: ByteStream, offsetinfotype: number): { oi: POffsetInfoType_Std; length: number } {
    const start = buffer.position;
    const oi = new POffsetInfoType_Std();
    // The order of addresses is swapped between old Std (8) and new (1) offsetinfotype.
    if (offsetinfotype === OffsetInfoType.Std) {
      oi.optimizedAddress = S7p.decodeUInt16LE(buffer);
      oi.nonoptimizedAddress = S7p.decodeUInt16LE(buffer);
    } else {
      oi.nonoptimizedAddress = S7p.decodeUInt16LE(buffer);
      oi.optimizedAddress = S7p.decodeUInt16LE(buffer);
    }
    return { oi, length: buffer.position - start };
  }

  override toString(): string {
    let s = "";
    s += "<POffsetInfoType_Std>" + NL;
    s += tag("OptimizedAddress", this.optimizedAddress);
    s += tag("NonoptimizedAddress", this.nonoptimizedAddress);
    s += "</POffsetInfoType_Std>" + NL;
    return s;
  }
}
