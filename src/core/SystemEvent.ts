/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { Datatype } from "./Datatype.js";
import { Ids } from "./Ids.js";
import { ProtocolVersion } from "./ProtocolVersion.js";
import { PValue, ValueLInt, ValueStruct } from "./PValue.js";
import { S7p } from "./S7p.js";

const NL = "\n";

/**
 * These extended keep-alive telegrams came up with TIA V14, and are sent from the PLC or HMI.
 * There is a version of 16 bytes length and another with 22 bytes length.
 * The 22 byte version may contain a string like "LOGOUT", but this only after a DeleteObject.
 * In contrast to all other protocol functions, the values don't use the VLQ encoding!
 */
export class SystemEvent {
  transportFlags = 0;
  returnValue = 0n;
  reserved1 = 0;
  confirmedBytes = 0;
  reserved2 = 0;
  reserved3 = 0;
  isData = false;
  data: PValue | null = null;
  isMessage = false;
  message = "";

  protocolVersion: number;

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
  }

  deserialize(buffer: ByteStream): number {
    const ret = 0;

    this.reserved1 = S7p.decodeUInt32(buffer);
    this.confirmedBytes = S7p.decodeUInt32(buffer);
    this.reserved2 = S7p.decodeUInt32(buffer);
    this.reserved3 = S7p.decodeUInt32(buffer);

    // If's possible that this is the end of the dataset, without data value or message string.
    const remainingLength = buffer.length - buffer.position;
    if (remainingLength >= 4) {
      // Heuristic check if next is a string or a struct
      const peekType = S7p.decodeUInt32(buffer);
      buffer.position -= 4; // set position back
      if (remainingLength >= 4 && peekType === Datatype.Struct) {
        // binary coded
        // This seems to work like ordinary values, but without that VLQ encoding.
        // So a UDINT is always 4 bytes long.
        this.isData = true;
        this.isMessage = false;
        this.data = PValue.deserialize(buffer, true /* disableVlq */);
      }
    }
    if (!this.isData && remainingLength > 0) {
      this.isMessage = true;
      // raw string without header or end termination.
      this.message = S7p.decodeWString(buffer, remainingLength);
    }
    return ret;
  }

  isFatalError(): boolean {
    // If we don't have a Data struct at all, then this is possibly just a kind of notification
    if (this.data !== null) {
      try {
        // We excpect Data is of type ValueStruct, and has a structmember "ReturnValue" 40305 of Type LInt
        if (!(this.data instanceof ValueStruct)) throw new Error("InvalidCast");
        const retval = this.data.getStructElement(Ids.ReturnValue);
        if (!(retval instanceof ValueLInt)) throw new Error("InvalidCast");
        // It's just guess that if the value is negative, then it's a fatal error and we need to disconnect
        return retval.getValue() < 0;
      } catch {
        return true;
      }
    }
    return false;
  }

  toString(): string {
    let s = "";
    s += "<SystemEvent>" + NL;
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + NL;
    s += "<Reserved1>" + this.reserved1.toString() + "</Reserved1>" + NL;
    s += "<ConfirmedBytes>" + this.confirmedBytes.toString() + "</ConfirmedBytes>" + NL;
    s += "<Reserved2>" + this.reserved2.toString() + "</ReReserved2served1>" + NL;
    s += "<Reserved3>" + this.reserved3.toString() + "</Reserved3>" + NL;
    if (this.isData) {
      s += "<Data>" + this.data!.toString() + "</Data>" + NL;
      s += "<Message></Message>" + NL;
    } else if (this.isMessage) {
      s += "<Data></Data>" + NL;
      s += "<Message>" + this.message + "</Message>" + NL;
    } else {
      s += "<Data></Data>" + NL;
      s += "<Message></Message>" + NL;
    }
    s += "</SystemEvent>" + NL;
    return s;
  }

  static deserializeFromPdu(pdu: ByteStream): SystemEvent | null {
    // Special handling of ProtocolVersion, which is written to the stream before
    const protocolVersion = S7p.decodeByte(pdu);
    if (protocolVersion !== ProtocolVersion.SystemEvent) {
      return null;
    }
    const sysevt = new SystemEvent(protocolVersion);
    sysevt.deserialize(pdu);
    return sysevt;
  }
}
