/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { ElementID } from "./ElementID.js";
import type { IS7pSerialize } from "./IS7pSerialize.js";
import type { PValue } from "./PValue.js";
import type { PVarnameList } from "./PVarnameList.js";
import type { PVartypeList } from "./PVartypeList.js";
import { S7p } from "./S7p.js";

const NL = "\n";

export class PObject implements IS7pSerialize {
  relationId: number;
  classId: number;
  classFlags: number;
  attributeId: number;
  attributes = new Map<number, PValue>();
  /** Key: `${classId}:${relationId}` (C# Tuple<ClassId, RelationId>); use getObjectByClassId / getObjects. */
  objects = new Map<string, PObject>();
  relations = new Map<number, number>();
  vartypeList: PVartypeList | null = null;
  varnameList: PVarnameList | null = null;

  constructor(RID = 0, CLSID = 0, AID = 0) {
    this.relationId = RID;
    this.classId = CLSID;
    this.classFlags = 0;
    this.attributeId = AID;
  }

  addAttribute(attributeid: number, value: PValue): void {
    if (this.attributes.has(attributeid)) {
      throw new Error("An item with the same key has already been added. Key: " + attributeid);
    }
    this.attributes.set(attributeid, value);
  }

  getAttribute(attributeid: number): PValue {
    const v = this.attributes.get(attributeid);
    if (v === undefined) throw new Error("The given key was not present in the dictionary. Key: " + attributeid);
    return v;
  }

  addRelation(relationid: number, value: number): void {
    if (this.relations.has(relationid)) {
      throw new Error("An item with the same key has already been added. Key: " + relationid);
    }
    this.relations.set(relationid, value);
  }

  setVartypeList(typelist: PVartypeList): void {
    this.vartypeList = typelist;
  }

  setVarnameList(namelist: PVarnameList): void {
    this.varnameList = namelist;
  }

  addObject(obj: PObject): void {
    // Whether using the ClassId as Key makes sense, remains to be seen
    // TODO: The ClassId is not unique and may be occur more than once
    // (e.g. DB.Class_Rid and in RelId is the DB number as DB.1)
    const key = obj.classId + ":" + obj.relationId;
    if (this.objects.has(key)) {
      throw new Error("An item with the same key has already been added. Key: " + key);
    }
    this.objects.set(key, obj);
  }

  getObjectByClassId(classId: number, relId: number): PObject {
    const o = this.objects.get(classId + ":" + relId);
    if (o === undefined) throw new Error("The given key was not present in the dictionary.");
    return o;
  }

  getObjectsByClassId(classId: number): PObject[] {
    const objList: PObject[] = [];
    for (const obj of this.objects.values()) {
      if (obj.classId === classId) {
        objList.push(obj);
      }
    }
    return objList;
  }

  getObjects(): PObject[] {
    return Array.from(this.objects.values());
  }

  serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeByte(buffer, ElementID.StartOfObject);
    ret += S7p.encodeUInt32(buffer, this.relationId);
    ret += S7p.encodeUInt32Vlq(buffer, this.classId);
    ret += S7p.encodeUInt32Vlq(buffer, this.classFlags);
    ret += S7p.encodeUInt32Vlq(buffer, this.attributeId);
    for (const [key, value] of this.attributes) {
      ret += S7p.encodeByte(buffer, ElementID.Attribute);
      ret += S7p.encodeUInt32Vlq(buffer, key);
      ret += value.serialize(buffer);
    }
    for (const o of this.objects.values()) {
      ret += o.serialize(buffer);
    }
    for (const [key, value] of this.relations) {
      ret += S7p.encodeByte(buffer, ElementID.Relation);
      ret += S7p.encodeUInt32Vlq(buffer, key);
      ret += S7p.encodeUInt32(buffer, value);
    }
    ret += S7p.encodeByte(buffer, ElementID.TerminatingObject);
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<Object>" + NL;
    s += "<RelationId>" + this.relationId.toString() + "</RelationId>" + NL;
    s += "<ClassId>" + this.classId.toString() + "</ClassId>" + NL;
    s += "<AttributeId>" + this.attributeId.toString() + "</AttributeId>" + NL;
    for (const [key, value] of this.attributes) {
      s += "<Attribute>" + NL;
      s += "<ID>" + key.toString() + "</ID>" + NL;
      s += value.toString();
      s += "</Attribute>" + NL;
    }
    if (this.vartypeList !== null) {
      s += this.vartypeList.toString();
    }
    if (this.varnameList !== null) {
      s += this.varnameList.toString();
    }
    for (const o of this.objects.values()) {
      s += o.toString();
    }
    for (const [key, value] of this.relations) {
      s += "<Relation>" + NL;
      s += "<ID>" + key.toString() + "</ID>" + NL;
      s += value.toString();
      s += "</Relation>" + NL;
    }
    s += "</Object>" + NL;
    return s;
  }
}
