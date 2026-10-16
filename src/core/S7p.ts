/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import { ByteStream } from "./ByteStream.js";
import { ElementID } from "./ElementID.js";
import { Ids } from "./Ids.js";
import { PObject } from "./PObject.js";
import { PVarnameList } from "./PVarnameList.js";
import { PVartypeList } from "./PVartypeList.js";
import { PValue, ValueAID, ValueRID, ValueUDInt } from "./PValue.js";

const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

/** Byte read like `(byte)stream.ReadByte()`: -1 (end of stream) becomes 0xff. */
function rb(buffer: ByteStream): number {
  return buffer.readByte() & 0xff;
}

export class S7p {
  static encodeByte(buffer: ByteStream, value: number): number {
    buffer.writeByte(value & 0xff);
    return 1;
  }

  static encodeUInt16(buffer: ByteStream, value: number): number {
    buffer.writeByte((value >> 8) & 0xff);
    buffer.writeByte(value & 0xff);
    return 2;
  }

  static encodeInt16(buffer: ByteStream, value: number): number {
    return S7p.encodeUInt16(buffer, value);
  }

  static encodeUInt32(buffer: ByteStream, value: number): number {
    buffer.writeByte((value >>> 24) & 0xff);
    buffer.writeByte((value >>> 16) & 0xff);
    buffer.writeByte((value >>> 8) & 0xff);
    buffer.writeByte(value & 0xff);
    return 4;
  }

  static encodeInt32(buffer: ByteStream, value: number): number {
    return S7p.encodeUInt32(buffer, value);
  }

  static encodeUInt64(buffer: ByteStream, value: bigint): number {
    const v = BigInt.asUintN(64, value);
    for (let s = 56n; s >= 0n; s -= 8n) {
      buffer.writeByte(Number((v >> s) & 0xffn));
    }
    return 8;
  }

  static encodeInt64(buffer: ByteStream, value: bigint): number {
    return S7p.encodeUInt64(buffer, value);
  }

  static decodeByte(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 1) return 0;
    return buffer.readByte();
  }

  static decodeUInt16(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 2) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    return ((a << 8) | b) & 0xffff;
  }

  /** Little Endian */
  static decodeUInt16LE(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 2) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    return (a | (b << 8)) & 0xffff;
  }

  static decodeInt16(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 2) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    return (((a << 8) | b) << 16) >> 16;
  }

  static decodeUInt32(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 4) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    const c = buffer.readByte();
    const d = buffer.readByte();
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  /** Little Endian */
  static decodeUInt32LE(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 4) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    const c = buffer.readByte();
    const d = buffer.readByte();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }

  /** Little Endian */
  static decodeInt32LE(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 4) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    const c = buffer.readByte();
    const d = buffer.readByte();
    return a | (b << 8) | (c << 16) | (d << 24);
  }

  static decodeInt32(buffer: ByteStream): number {
    if (buffer.length - buffer.position < 4) return 0;
    const a = buffer.readByte();
    const b = buffer.readByte();
    const c = buffer.readByte();
    const d = buffer.readByte();
    return (a << 24) | (b << 16) | (c << 8) | d;
  }

  static decodeUInt64(buffer: ByteStream): bigint {
    if (buffer.length - buffer.position < 8) return 0n;
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buffer.readByte());
    return v;
  }

  static decodeInt64(buffer: ByteStream): bigint {
    return BigInt.asIntN(64, S7p.decodeUInt64(buffer));
  }

  static encodeUInt32Vlq(buffer: ByteStream, value: number): number {
    value = value >>> 0;
    const bytes = new Uint8Array(5);
    let i: number;
    let j: number;
    for (i = 4; i > 0; i--) {
      if ((value & (0x7f << (i * 7))) !== 0) {
        break;
      }
    }
    for (j = 0; j <= i; j++) {
      bytes[j] = ((value >>> ((i - j) * 7)) & 0x7f) | 0x80;
    }
    bytes[i] ^= 0x80;
    buffer.write(bytes, 0, i + 1);
    return i + 1;
  }

  static decodeUInt32Vlq(buffer: ByteStream): number {
    let val = 0;
    for (let counter = 1; counter <= 5; counter++) {
      let octet = rb(buffer);
      val = (val << 7) >>> 0;
      const cont = octet & 0x80;
      octet &= 0x7f;
      val = (val + octet) >>> 0;
      if (cont === 0) {
        break;
      }
    }
    return val;
  }

  static decodeInt32Vlq(buffer: ByteStream): number {
    let val = 0;
    for (let counter = 1; counter <= 5; counter++) {
      let octet = rb(buffer);
      if (counter === 1 && (octet & 0x40) !== 0) {
        // check sign
        octet &= 0xbf;
        val = -64; // pre-load with one complement, excluding first 6 bits
      } else {
        val = val << 7;
      }
      const cont = octet & 0x80;
      octet &= 0x7f;
      val = (val + octet) | 0;
      if (cont === 0) {
        break;
      }
    }
    return val;
  }

  static encodeInt32Vlq(buffer: ByteStream, value: number): number {
    // You can write negative values like
    // -1234567
    // with full one complement bytes as:
    // 8f ff b4 d2 79
    // The read back value (from plc) is encoded as:
    // ff b4 d2 79
    //   or:
    // -255
    // Write with full one complement bytes as:
    // 8f ff ff fe 01
    // The read back value (from plc) is encoded as:
    // fe 01
    //
    // The actual method writes the values in the 2nd compact variant.
    // The decode algorithms can handle both variants.
    value = value | 0;
    const b = new Uint8Array(5);
    let absV: number;
    if (value === -2147483648) {
      absV = 2147483648;
    } else {
      absV = Math.abs(value);
    }

    b[0] = value & 0x7f;
    let length = 1;
    for (let i = 1; i < 5; i++) {
      if (absV >= 0x40) {
        length++;
        absV = absV >>> 7;
        value >>= 7;
        b[i] = ((value & 0x7f) + 0x80) & 0xff;
      } else {
        break;
      }
    }

    // Reverse order of bytes
    for (let i = length - 1; i >= 0; i--) {
      buffer.write(b, i, 1);
    }
    return length;
  }

  static encodeUInt64Vlq(buffer: ByteStream, value: bigint): number {
    // Special handling in the 64 bit VLQ variants:
    // The special handling on the 64 bit variants is neccessary, because without this we would need
    // max. 10 bytes than the max. 9 now.
    // Every byte looses 1 bit for the "continue" flag. For 8 bytes loosing 1 bit, we need 1 more byte.
    // Which in the normal variant would have only 7 bit of space, because 1 bit is for the "continue" flag.
    // The special handling allows to use all 8 bits in the additional 9th byte.
    value = BigInt.asUintN(64, value);
    const b = new Uint8Array(9);

    const special = value > 0x00ffffffffffffffn;
    if (special) {
      b[0] = Number(value & 0xffn);
    } else {
      b[0] = Number(value & 0x7fn);
    }

    let length = 1;
    for (let i = 1; i < 9; i++) {
      if (value >= 0x80n) {
        length++;
        if (i === 1 && special) {
          value >>= 8n;
        } else {
          value >>= 7n;
        }
        b[i] = Number((value & 0x7fn) + 0x80n) & 0xff;
      } else {
        break;
      }
    }

    if (special && length === 8) {
      // If the guess from above is, that we need 9 bytes but the value encoding would still fit into 8 bytes, then we need
      // to write an empty 0x80 value for continue flag.
      // Example: 123456789012345678 would be "ed d3 b4 dd 98 e1 f3 4e" and fit into 8 bytes.
      // But writing would fail.
      // Testcases where the special handling is needed are values:
      // - 0x00FFFFFFFFFFFFFF      -> standard
      // - 0x00FFFFFFFFFFFFFF + 1  -> additional 0x80 needed
      // The decode algorithm can handle both variants, but the plc accepts it only with the additional bytes (seems Siemens
      // uses a different algorithm than we are using)
      length++;
      b[8] = 0x80;
    }

    // Reverse order of bytes
    for (let i = length - 1; i >= 0; i--) {
      buffer.write(b, i, 1);
    }
    return length;
  }

  static decodeUInt64Vlq(buffer: ByteStream): bigint {
    let val = 0n;
    let cont = 0;
    for (let counter = 1; counter <= 8; counter++) {
      let octet = rb(buffer);
      val = BigInt.asUintN(64, val << 7n);
      cont = octet & 0x80;
      octet &= 0x7f;
      val = BigInt.asUintN(64, val + BigInt(octet));
      if (cont === 0) {
        break;
      }
    }
    if (cont > 0) {
      /* 8*7 bit + 8 bit = 64 bit -> Special case in last octet! */
      const octet = rb(buffer);
      val = BigInt.asUintN(64, val << 8n);
      val = BigInt.asUintN(64, val + BigInt(octet));
    }
    return val;
  }

  static decodeInt64Vlq(buffer: ByteStream): bigint {
    let val = 0n;
    let cont = 0;
    for (let counter = 1; counter <= 8; counter++) {
      let octet = rb(buffer);
      if (counter === 1 && (octet & 0x40) !== 0) {
        // check sign
        octet &= 0xbf;
        val = -64n; // pre-load with one complement, excluding first 6 bits
      } else {
        val = BigInt.asIntN(64, val << 7n);
      }
      cont = octet & 0x80;
      octet &= 0x7f;
      val = BigInt.asIntN(64, val + BigInt(octet));
      if (cont === 0) {
        break;
      }
    }
    if (cont > 0) {
      // 8*7 bit + 8 bit = 64 bit -> Special case in last octet!
      const octet = rb(buffer);
      val = BigInt.asIntN(64, val << 8n);
      val = BigInt.asIntN(64, val + BigInt(octet));
    }
    return val;
  }

  static encodeInt64Vlq(buffer: ByteStream, value: bigint): number {
    value = BigInt.asIntN(64, value);
    const b = new Uint8Array(9);
    let absV: bigint;
    if (value === -9223372036854775808n) {
      absV = 9223372036854775808n;
    } else {
      absV = value < 0n ? -value : value;
    }

    const special = absV > 0x007fffffffffffffn;
    if (special) {
      b[0] = Number(value & 0xffn);
    } else {
      b[0] = Number(value & 0x7fn);
    }

    let length = 1;
    for (let i = 1; i < 9; i++) {
      if (absV >= 0x40n) {
        length++;
        if (i === 1 && special) {
          absV >>= 8n;
          value >>= 8n;
        } else {
          absV >>= 7n;
          value >>= 7n;
        }
        b[i] = Number((value & 0x7fn) + 0x80n) & 0xff;
      } else {
        break;
      }
    }

    if (special && length === 8) {
      // See comment at encodeUInt64Vlq.
      // Because of the sign bit, the special handling starts here at > 0x007fffffffffffff
      // And we need a different value for negative numbers.
      length++;
      if (value >= 0n) {
        b[8] = 0x80;
      } else {
        b[8] = 0xff;
      }
    }

    // Reverse order of bytes
    for (let i = length - 1; i >= 0; i--) {
      buffer.write(b, i, 1);
    }
    return length;
  }

  static encodeFloat(buffer: ByteStream, value: number): number {
    const dv = new DataView(new ArrayBuffer(4));
    // NaN: JS cannot carry the sign/payload; write the bit pattern of C# float.NaN (0xFFC00000)
    if (Number.isNaN(value)) dv.setUint32(0, 0xffc00000, false);
    else dv.setFloat32(0, value, false);
    buffer.write(new Uint8Array(dv.buffer));
    return 4;
  }

  static decodeFloat(buffer: ByteStream): number {
    const dv = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < 4; i++) dv.setUint8(i, rb(buffer));
    return dv.getFloat32(0, false);
  }

  static encodeDouble(buffer: ByteStream, value: number): number {
    const dv = new DataView(new ArrayBuffer(8));
    // NaN: write the bit pattern of C# double.NaN (0xFFF8000000000000)
    if (Number.isNaN(value)) { dv.setUint32(0, 0xfff80000, false); dv.setUint32(4, 0, false); }
    else dv.setFloat64(0, value, false);
    buffer.write(new Uint8Array(dv.buffer));
    return 8;
  }

  static decodeDouble(buffer: ByteStream): number {
    const dv = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) dv.setUint8(i, rb(buffer));
    return dv.getFloat64(0, false);
  }

  static encodeWString(buffer: ByteStream, value: string): number {
    const bytes = utf8Encoder.encode(value);
    buffer.write(bytes, 0, bytes.length);
    return bytes.length;
  }

  /** Returns the decoded string ("" when not enough data); bytes consumed = `length` on success. */
  static decodeWString(buffer: ByteStream, length: number): string {
    length |= 0; // C# callers cast the uint length to int: values >= 2^31 become negative (new byte[-1] -> OverflowException)
    if (buffer.length - buffer.position < length) {
      return "";
    }
    const tmp = new Uint8Array(length);
    buffer.read(tmp, 0, length);
    return utf8Decoder.decode(tmp);
  }

  static encodeOctets(buffer: ByteStream, value: Uint8Array | null | undefined): number {
    if (value == null || value.length === 0) return 0;
    buffer.write(value, 0, value.length);
    return value.length;
  }

  /** Returns an empty array (C# returned null) when length <= 0 or not enough data. */
  static decodeOctets(buffer: ByteStream, length: number): Uint8Array {
    length |= 0; // C# callers cast the uint length to int
    if (length <= 0 || buffer.length - buffer.position < length) {
      return new Uint8Array(0);
    }
    const value = new Uint8Array(length);
    buffer.read(value, 0, length);
    return value;
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  // High Level Decode/Encode methods

  /** Decodes a list of objects. Bytes consumed = buffer.position - start. */
  static decodeObjectList(buffer: ByteStream): PObject[] {
    const objList: PObject[] = [];
    // Peek one byte and set buffer back
    let tagId = S7p.decodeByte(buffer);
    buffer.position -= 1;
    while (tagId === ElementID.StartOfObject) {
      const obj = S7p.decodeObject(buffer, null, true);
      objList.push(obj as PObject);
      tagId = S7p.decodeByte(buffer);
      buffer.position -= 1;
    }
    return objList;
  }

  /**
   * C# `ref PObject obj` becomes parameter + return value: pass the current object (or null)
   * and use the returned object. Bytes consumed = buffer.position - start.
   */
  static decodeObject(buffer: ByteStream, obj: PObject | null = null, asList = false): PObject | null {
    let terminate = false;
    do {
      const tagId = S7p.decodeByte(buffer);
      switch (tagId) {
        case ElementID.StartOfObject:
          if (obj === null) {
            obj = new PObject();
            obj.relationId = S7p.decodeUInt32(buffer);
            obj.classId = S7p.decodeUInt32Vlq(buffer);
            obj.classFlags = S7p.decodeUInt32Vlq(buffer);
            obj.attributeId = S7p.decodeUInt32Vlq(buffer);
            // If a List is expected, don't add the objects coming next to the parent object
            // TODO: May be it's better to always expect a list? Adding the following objects to the first as children must always be wrong.
            if (asList === false) {
              obj = S7p.decodeObject(buffer, obj);
            }
          } else {
            let newobj: PObject | null = new PObject();
            newobj.relationId = S7p.decodeUInt32(buffer);
            newobj.classId = S7p.decodeUInt32Vlq(buffer);
            newobj.classFlags = S7p.decodeUInt32Vlq(buffer);
            newobj.attributeId = S7p.decodeUInt32Vlq(buffer);
            newobj = S7p.decodeObject(buffer, newobj);
            obj.addObject(newobj as PObject);
          }
          break;
        case ElementID.TerminatingObject:
          terminate = true;
          break;
        case ElementID.Attribute: {
          const id = S7p.decodeUInt32Vlq(buffer);
          // PValue.deserialize may return null for unknown datatypes (like C#)
          obj!.addAttribute(id, PValue.deserialize(buffer) as PValue);
          break;
        }
        case ElementID.StartOfTagDescription:
          // Skip, only 1200 FW2 and maybe older, which definitively don't support TLS
          break;
        case ElementID.VartypeList: {
          const typelist = new PVartypeList();
          typelist.deserialize(buffer);
          obj!.setVartypeList(typelist);
          break;
        }
        case ElementID.VarnameList: {
          const namelist = new PVarnameList();
          namelist.deserialize(buffer);
          obj!.setVarnameList(namelist);
          break;
        }
        default:
          terminate = true;
          break;
      }
    } while (terminate === false);
    return obj;
  }

  /** `ret` is 4 on success, 0 if not enough data. */
  static decodeHeader(buffer: ByteStream): { ret: number; version: number; length: number } {
    if (buffer.length - buffer.position < 4) {
      return { ret: 0, version: 0, length: 0 };
    }
    buffer.readByte(); // Skip one byte (purpose unclear)
    const version = buffer.readByte() & 0xff;
    const length = S7p.decodeUInt16(buffer);
    return { ret: 4, version, length };
  }

  static encodeHeader(buffer: ByteStream, version: number, length: number): number {
    buffer.writeByte(0x72);
    buffer.writeByte(version);
    S7p.encodeUInt16(buffer, length);
    return 4;
  }

  static encodeObjectQualifier(buffer: ByteStream): number {
    let ret = 0;

    ret += S7p.encodeUInt32(buffer, Ids.ObjectQualifier);

    const parentRID = new ValueRID(0);
    const compositionAID = new ValueAID(0);
    const keyQualifier = new ValueUDInt(0);

    ret += S7p.encodeUInt32Vlq(buffer, Ids.ParentRID);
    ret += parentRID.serialize(buffer);

    ret += S7p.encodeUInt32Vlq(buffer, Ids.CompositionAID);
    ret += compositionAID.serialize(buffer);

    ret += S7p.encodeUInt32Vlq(buffer, Ids.KeyQualifier);
    ret += keyQualifier.serialize(buffer);

    ret += S7p.encodeByte(buffer, 0);

    return ret;
  }
}
