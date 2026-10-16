/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { POffsetInfoType } from "./POffsetInfoType.js";
import { S7p } from "./S7p.js";

const NL = "\n";

export class PVartypeList {
  elements: PVartypeListElement[] = [];
  firstId = 0;

  /** Returns number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    const consumed = () => buffer.position - start;

    this.elements = [];

    let blocklen = S7p.decodeUInt16(buffer);
    let maxret = consumed() + blocklen;
    // This ID occurs only on the first block.
    this.firstId = S7p.decodeUInt32LE(buffer);

    while (blocklen > 0) {
      do {
        const elem = new PVartypeListElement();
        elem.deserialize(buffer);
        this.elements.push(elem);
      } while (consumed() < maxret);
      blocklen = S7p.decodeUInt16(buffer);
      maxret = consumed() + blocklen;
    }
    return consumed();
  }

  toString(): string {
    let s = "";
    s += "<VartypeList>" + NL;
    s += "<FirstId>" + this.firstId.toString() + "</FirstId>" + NL;
    let i = 1;
    for (const elem of this.elements) {
      s += '<Element index="' + i.toString() + '">' + NL;
      s += elem.toString();
      s += "</Element>" + NL;
      i++;
    }
    s += "</VartypeList>" + NL;
    return s;
  }
}

/* flags in tag description for 1500 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_OFFSETINFOTYPE = 0xf000; /* Bits 13..16 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_HMIVISIBLE = 0x0800; /* Bit 12 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_HMIREADONLY = 0x0400; /* Bit 11 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_HMIACCESSIBLE = 0x0200; /* Bit 10 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_BIT09 = 0x0100; /* Bit 09 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_OPTIMIZEDACCESS = 0x0080; /* Bit 08 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_SECTION = 0x0070; /* Bits 05..07 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_BIT04 = 0x0008; /* Bit 04 */
const S7COMMP_TAGDESCR_ATTRIBUTE2_BITOFFSET = 0x0007; /* Bits 01..03 */
void S7COMMP_TAGDESCR_ATTRIBUTE2_BIT09;
void S7COMMP_TAGDESCR_ATTRIBUTE2_BIT04;

const S7COMMP_TAGDESCR_BITOFFSETINFO_RETAIN = 0x80;
const S7COMMP_TAGDESCR_BITOFFSETINFO_NONOPTBITOFFSET = 0x70;
const S7COMMP_TAGDESCR_BITOFFSETINFO_CLASSIC = 0x08;
const S7COMMP_TAGDESCR_BITOFFSETINFO_OPTBITOFFSET = 0x07;

export class PVartypeListElement {
  lid = 0;
  symbolCrc = 0;
  softdatatype = 0;
  attributeFlags = 0;
  bitoffsetinfoFlags = 0;
  offsetInfoType: POffsetInfoType | null = null;

  getAttributeSection(): number {
    return (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_SECTION) >> 4;
  }

  getAttributeBitoffset(): number {
    return this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_BITOFFSET;
  }

  getAttributeFlagHmiVisible(): boolean {
    return (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_HMIVISIBLE) !== 0;
  }

  getAttributeFlagHmiAccessible(): boolean {
    return (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_HMIACCESSIBLE) !== 0;
  }

  getAttributeFlagOptimizedAccess(): boolean {
    return (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_OPTIMIZEDACCESS) !== 0;
  }

  getAttributeFlagHmiReadonly(): boolean {
    return (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_HMIREADONLY) !== 0;
  }

  getBitoffsetinfoFlagRetain(): boolean {
    return (this.bitoffsetinfoFlags & S7COMMP_TAGDESCR_BITOFFSETINFO_RETAIN) !== 0;
  }

  getBitoffsetinfoFlagClassic(): boolean {
    return (this.bitoffsetinfoFlags & S7COMMP_TAGDESCR_BITOFFSETINFO_CLASSIC) !== 0;
  }

  getBitoffsetinfoNonoptimizedBitoffset(): number {
    return (this.bitoffsetinfoFlags & S7COMMP_TAGDESCR_BITOFFSETINFO_NONOPTBITOFFSET) >> 4;
  }

  getBitoffsetinfoOptimizedBitoffset(): number {
    return this.bitoffsetinfoFlags & S7COMMP_TAGDESCR_BITOFFSETINFO_OPTBITOFFSET;
  }

  /** Returns number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;

    this.lid = S7p.decodeUInt32LE(buffer);
    this.symbolCrc = S7p.decodeUInt32LE(buffer);
    this.softdatatype = S7p.decodeByte(buffer); // For keepint the type similar
    this.attributeFlags = S7p.decodeUInt16(buffer);

    const offsetinfotype = (this.attributeFlags & S7COMMP_TAGDESCR_ATTRIBUTE2_OFFSETINFOTYPE) >> 12;

    this.bitoffsetinfoFlags = S7p.decodeByte(buffer);

    this.offsetInfoType = POffsetInfoType.deserialize(buffer, offsetinfotype).oi;

    return buffer.position - start;
  }

  toString(): string {
    let s = "";
    s += "<VartypeListElement>" + NL;
    s += "<LID>" + this.lid.toString() + "</LID>" + NL;
    s += "<SymbolCRC>" + this.symbolCrc.toString() + "</SymbolCRC>" + NL;
    s += "<AttributeFlags>" + this.attributeFlags.toString() + "</AttributeFlags>" + NL;
    s += "<BitoffsetinfoFlags>" + this.bitoffsetinfoFlags.toString() + "</BitoffsetinfoFlags>" + NL;
    s += "<OffsetInfoType>" + this.offsetInfoType!.toString() + "</OffsetInfoType>" + NL;
    s += "</VartypeListElement>" + NL;
    return s;
  }
}
