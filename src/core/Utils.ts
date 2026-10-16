/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

const HexChars = "0123456789ABCDEF";

export class Utils {
  static hexDump(bytes: Uint8Array | null | undefined, bytesPerLine = 16): string {
    if (bytes == null) return "<null>";
    const bytesLength = bytes.length;
    const NewLine = "\n";

    const firstHexColumn =
      8 + // 8 characters for the address
      3; // 3 spaces

    const firstCharColumn =
      firstHexColumn +
      bytesPerLine * 3 + // - 2 digit for the hexadecimal value and 1 space
      Math.trunc((bytesPerLine - 1) / 8) + // - 1 extra space every 8 characters from the 9th
      2; // 2 spaces

    const lineLength = firstCharColumn + bytesPerLine; // characters to show the ascii value

    let result = "";
    for (let i = 0; i < bytesLength; i += bytesPerLine) {
      const line: string[] = new Array(lineLength).fill(" ");
      line[0] = HexChars[(i >> 28) & 0xf];
      line[1] = HexChars[(i >> 24) & 0xf];
      line[2] = HexChars[(i >> 20) & 0xf];
      line[3] = HexChars[(i >> 16) & 0xf];
      line[4] = HexChars[(i >> 12) & 0xf];
      line[5] = HexChars[(i >> 8) & 0xf];
      line[6] = HexChars[(i >> 4) & 0xf];
      line[7] = HexChars[(i >> 0) & 0xf];

      let hexColumn = firstHexColumn;
      let charColumn = firstCharColumn;

      for (let j = 0; j < bytesPerLine; j++) {
        if (j > 0 && (j & 7) === 0) hexColumn++;
        if (i + j >= bytesLength) {
          line[hexColumn] = " ";
          line[hexColumn + 1] = " ";
          line[charColumn] = " ";
        } else {
          const b = bytes[i + j];
          line[hexColumn] = HexChars[(b >> 4) & 0xf];
          line[hexColumn + 1] = HexChars[b & 0xf];
          line[charColumn] = b < 32 ? "·" : String.fromCharCode(b);
        }
        hexColumn += 3;
        charColumn++;
      }
      result += line.join("") + NewLine;
    }
    return result;
  }

  /**
   * Protocol ValueTimestamp is number of nanoseconds from 1. Jan 1970 (Unix time, UTC).
   * Returns a JS Date (millisecond precision, sub-ms part is dropped).
   */
  static dtFromValueTimestamp(value: bigint): Date {
    return new Date(Number(BigInt.asUintN(64, value) / 1_000_000n));
  }

  /** Nanoseconds since 1. Jan 1970 (UTC) as bigint, full precision of the protocol value. */
  static dtNsFromValueTimestamp(value: bigint): bigint {
    return BigInt.asUintN(64, value);
  }

  /** Emulates C# array bounds checking (IndexOutOfRangeException) for reads of `n` bytes at `pos` */
  private static chk(array: Uint8Array, pos: number, n: number): void {
    if (pos < 0 || pos + n > array.length) throw new RangeError("Index was outside the bounds of the array.");
  }

  static getUInt8(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 1);
    return array[pos];
  }

  static getUInt16LE(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 2);
    return array[pos + 1] * 256 + array[pos];
  }

  static getUInt16(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 2);
    return array[pos] * 256 + array[pos + 1];
  }

  static getInt16(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 2);
    return (((array[pos] << 8) | array[pos + 1]) << 16) >> 16;
  }

  static getUInt32LE(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 4);
    return array[pos + 3] * 16777216 + array[pos + 2] * 65536 + array[pos + 1] * 256 + array[pos];
  }

  static getUInt32(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 4);
    return array[pos] * 16777216 + array[pos + 1] * 65536 + array[pos + 2] * 256 + array[pos + 3];
  }

  static getInt32(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 4);
    return (array[pos] << 24) | (array[pos + 1] << 16) | (array[pos + 2] << 8) | array[pos + 3];
  }

  static getFloat(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 4);
    return new DataView(array.buffer, array.byteOffset + pos, 4).getFloat32(0, false);
  }

  static getDouble(array: Uint8Array, pos: number): number {
    Utils.chk(array, pos, 8);
    return new DataView(array.buffer, array.byteOffset + pos, 8).getFloat64(0, false);
  }

  static getUtfString(array: Uint8Array, pos: number, len: number): string {
    Utils.chk(array, pos, len); // (C#: ArgumentOutOfRangeException)
    return new TextDecoder("utf-8").decode(array.subarray(pos, pos + len));
  }
}
