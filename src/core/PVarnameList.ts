/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { S7p } from "./S7p.js";

export class PVarnameList {
  names: string[] = [];

  /** Returns number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    const consumed = () => buffer.position - start;

    this.names = [];

    let blocklen = S7p.decodeUInt16(buffer);
    let maxret = consumed() + blocklen;
    while (blocklen > 0) {
      do {
        // Length of a name is max. 128 chars
        const namelen = S7p.decodeByte(buffer);
        const name = S7p.decodeWString(buffer, namelen);
        this.names.push(name);
        // Additional 1 Byte with 0 at the end. Why Null termination when the length is given? I don't know...
        S7p.decodeByte(buffer);
      } while (consumed() < maxret);
      blocklen = S7p.decodeUInt16(buffer);
      maxret = consumed() + blocklen;
    }
    return consumed();
  }

  toString(): string {
    let s = "";
    let i = 1;
    s += "<VarnameList>\n";
    for (const name of this.names) {
      s += '<Name index="' + i.toString() + '">' + name + "</Name>\n";
      i++;
    }
    s += "</VarnameList>\n";
    return s;
  }
}
