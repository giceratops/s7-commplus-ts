/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */
import type { ByteStream } from "../core/ByteStream.js";
import type { IS7pSerialize } from "../core/IS7pSerialize.js";
import { Ids } from "../core/Ids.js";
import { S7p } from "../core/S7p.js";

const NL = "\n";

export class ItemAddress implements IS7pSerialize {
  symbolCrc = 0;
  accessArea = 0;
  accessSubArea = 0;
  lid: number[] = [];

  /**
   * Overloads:
   *  - ()                    -> area 0, Ids.DB_ValueActual
   *  - (area, subArea)       -> numeric area / sub area
   *  - (variableAccessString)-> hexadecimal ids separated by ".", e.g. 8A0E0001.A or 52.A
   */
  constructor();
  constructor(area: number, subArea: number);
  constructor(variableAccessString: string);
  constructor(a?: number | string, b?: number) {
    if (typeof a === "string") {
      // Uses a complete access string consisting of hexadecimal strings separated by a dot (".").
      // Returns a list of the extracted IDs, e.g. 8A0E0001.A or 52.A
      const ids: number[] = [];
      for (const p of a.split(".")) {
        if (!/^[0-9a-fA-F]+$/.test(p)) {
          throw new Error("Input string was not in a correct format.");
        }
        ids.push(parseInt(p, 16) >>> 0);
      }
      // TODO: Check for an error, number of fields should be at least 2
      this.symbolCrc = 0;
      this.accessArea = ids[0];
      // Set access area
      if (this.accessArea >= 0x8a0e0000) {
        // 0x8A0A.... = datablocks
        this.accessSubArea = Ids.DB_ValueActual;
      } else if (
        this.accessArea === Ids.NativeObjects_theS7Timers_Rid ||
        this.accessArea === Ids.NativeObjects_theS7Counters_Rid ||
        this.accessArea === Ids.NativeObjects_theIArea_Rid ||
        this.accessArea === Ids.NativeObjects_theQArea_Rid ||
        this.accessArea === Ids.NativeObjects_theMArea_Rid
      ) {
        this.accessSubArea = Ids.ControllerArea_ValueActual;
      }
      for (const i of ids.slice(1)) {
        this.lid.push(i);
      }
    } else {
      this.symbolCrc = 0;
      this.accessArea = a === undefined ? 0 : a;
      this.accessSubArea = b === undefined ? Ids.DB_ValueActual : b;
    }
  }

  getAccessString(): string {
    // Generate from the given address an Access-String.
    // Useful if the user has set the address not via access string, but by the single elements.
    let s = (this.accessArea >>> 0).toString(16).toUpperCase();
    for (const i of this.lid) {
      s += "." + (i >>> 0).toString(16).toUpperCase();
    }
    return s;
  }

  getNumberOfFields(): number {
    return 4 + this.lid.length;
  }

  setAccessAreaToDatablock(num: number): void {
    this.accessArea = ((num & 0xffff) + 0x8a0e0000) >>> 0;
  }

  serialize(buffer: ByteStream): number {
    let ret = 0;
    ret += S7p.encodeUInt32Vlq(buffer, this.symbolCrc);
    ret += S7p.encodeUInt32Vlq(buffer, this.accessArea);
    ret += S7p.encodeUInt32Vlq(buffer, this.lid.length + 1);
    ret += S7p.encodeUInt32Vlq(buffer, this.accessSubArea);
    for (const id of this.lid) {
      ret += S7p.encodeUInt32Vlq(buffer, id);
    }
    return ret;
  }

  toString(): string {
    let s = "";
    s += "<ItemAddress>" + NL;
    s += "<SymbolCrc>" + this.symbolCrc.toString() + "</SymbolCrc>" + NL;
    s += "<AccessArea>" + this.accessArea.toString() + "</AccessArea>" + NL;
    s += "<NumberOfIDs>" + (this.lid.length + 1).toString() + "</NumberOfIDs>" + NL;
    s += "<AccessSubArea>" + this.accessSubArea.toString() + "</AccessSubArea>" + NL;
    for (const id of this.lid) {
      s += "<LIDvalue>" + id.toString() + "</LIDvalue>" + NL;
    }
    s += "</ItemAddress>" + NL;
    return s;
  }
}
