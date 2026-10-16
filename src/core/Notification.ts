/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";
import { Opcode } from "./Opcode.js";
import type { PObject } from "./PObject.js";
import { PValue } from "./PValue.js";
import { S7p } from "./S7p.js";

const NL = "\n";

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

export class Notification {
  protocolVersion: number;

  subscriptionObjectId = 0;
  unknown2 = 0;
  unknown3 = 0;
  unknown4 = 0;

  notificationCreditTick = 0;
  notificationSequenceNumber = 0;
  subscriptionChangeCounter = 0;

  /** C# default DateTime.MinValue (0001-01-01). */
  add1Timestamp: Date = new Date(-62135596800000);
  add1SubscriptionChangeCounter = 0;

  values: Map<number, PValue>; // Item reference number, Value
  returnValues: Map<number, number>; // Item reference number, ReturnValue

  p2SubscriptionObjectId = 0; // for alarm object
  p2Unknown1 = 0; // for alarm object
  p2ReturnValue = 0; // for alarm object
  p2Objects: PObject[] = []; // for alarm object

  constructor(protocolVersion: number) {
    this.protocolVersion = protocolVersion;
    this.values = new Map();
    this.returnValues = new Map();
  }

  /** Returns number of bytes consumed. */
  deserialize(buffer: ByteStream): number {
    const start = buffer.position;
    let itemReturnValue: number;
    let itemref: number;

    this.subscriptionObjectId = S7p.decodeUInt32(buffer);
    this.unknown2 = S7p.decodeUInt16(buffer);
    this.unknown3 = S7p.decodeUInt16(buffer);
    this.unknown4 = S7p.decodeUInt16(buffer);

    this.notificationCreditTick = S7p.decodeByte(buffer);
    this.notificationSequenceNumber = S7p.decodeUInt32Vlq(buffer);
    const subscrccnt = S7p.decodeByte(buffer);
    if (subscrccnt > 0) {
      this.subscriptionChangeCounter = subscrccnt;
    } else {
      // Newer versions of 1500 if subscrccnt ==0:
      // If this is zero, then an 8 byte UTC Timestamp on microsecond basis follows,
      // where the first byte should be always zero (in the 'near' future).
      buffer.position -= 1; // Set position back
      const timestamp = S7p.decodeUInt64(buffer);
      // Convert to JS Date (microseconds since Unix epoch -> ms)
      this.add1Timestamp = new Date(Number(timestamp / 1000n));
      this.add1SubscriptionChangeCounter = S7p.decodeByte(buffer);
    }
    // Return value: If the value != 0 then follows a dataset with the common known structure.
    // If an access error occurs, we have here an error-value, in this case datatype==NULL.
    // TODO: The returncodes follow not any known structure. I've tried to reproduce some errors
    // on different controllers and generations with the following results:
    //  hex       bin       ref-id  value   description
    //  0x03 = 0000 0011 -> ntohl   -       Addressing error (S7-1500 - Plcsim), like 0x13
    //  0x13 = 0001 0011 -> ntohl   -       Addressing error (S7-1200) and 1500-Plcsim
    //  0x81 = 1000 0001 ->         object  Standard object starts with 0xa1 (only in protocol version v1?)
    //  0x83 = 1000 0011 ->         value   Standard value structure, then notification value-list (only in protocol version v1?)
    //  0x92 = 1001 0010 -> ntohl   value   Success (S7-1200)
    //  0x9b = 1001 1011 -> vlq32   value   Seen on 1500 and 1200. Following ID or number, then flag, type, value
    //  0x9c = 1001 1100 -> ntohl   ?       Online with variable status table (S7-1200), structure seems to be completely different
    do {
      itemReturnValue = S7p.decodeByte(buffer);
      switch (itemReturnValue) {
        case 0x00:
          break;
        case 0x92:
          // Item reference number: Is sent to plc in the subscription-telegram for the addresses.
          itemref = S7p.decodeUInt32(buffer);
          this.addValue(itemref, PValue.deserialize(buffer) as PValue);
          break;
        case 0x9b:
          itemref = S7p.decodeUInt32Vlq(buffer);
          this.addValue(itemref, PValue.deserialize(buffer) as PValue);
          break;
        case 0x9c:
          // Don't do anything with the data (for now)
          S7p.decodeUInt32(buffer);
          break;
        case 0x13:
        case 0x03:
          itemref = S7p.decodeUInt32(buffer);
          if (this.returnValues.has(itemref)) throw new Error("An item with the same key has already been added.");
          this.returnValues.set(itemref, itemReturnValue);
          break;
        //case 0x81: //Only in protocol version v1, but also used in S7-1500 in part 2 for ProgramAlarm
        case 0x83:
          // Probably only in protocol version v1
          throw new Error("NotImplemented");
        default:
          // unknown return value
          throw new Error("NotImplemented");
      }
    } while (itemReturnValue !== 0);

    // If next byte is not zero, an alarm notification object may follow
    const peekByte = S7p.decodeByte(buffer);
    // Set position back
    buffer.position -= 1;
    if (peekByte !== 0) {
      this.p2SubscriptionObjectId = S7p.decodeUInt32(buffer);
      this.p2Unknown1 = S7p.decodeUInt16(buffer);
      this.p2ReturnValue = S7p.decodeByte(buffer);
      // It's not known if there are more than one object (as List), each object has
      // it's return value, or if there is really only one.
      // I wasn't able to produce a notification with more than one.
      if (this.p2ReturnValue === 0x81) {
        this.p2Objects = S7p.decodeObjectList(buffer);
      } else {
        throw new Error("NotImplemented");
      }
    }
    return buffer.position - start;
  }

  private addValue(itemref: number, v: PValue): void {
    if (this.values.has(itemref)) throw new Error("An item with the same key has already been added.");
    this.values.set(itemref, v);
  }

  toString(): string {
    const d = this.add1Timestamp;
    const ts =
      `${d.getUTCFullYear().toString().padStart(4, "0")}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
      `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)} UTC`;
    let s = "";
    s += "<Notification>" + NL;
    s += "<ProtocolVersion>" + this.protocolVersion.toString() + "</ProtocolVersion>" + NL;
    s += "<SubscriptionObjectId>" + this.subscriptionObjectId.toString() + "</SubscriptionObjectId>" + NL;
    s += "<Unknown2>" + this.unknown2.toString() + "</Unknown2>" + NL;
    s += "<Unknown3>" + this.unknown3.toString() + "</Unknown3>" + NL;
    s += "<Unknown4>" + this.unknown4.toString() + "</Unknown4>" + NL;
    s += "<NotificationCreditTick>" + this.notificationCreditTick.toString() + "</NotificationCreditTick>" + NL;
    s += "<NotificationSequenceNumber>" + this.notificationSequenceNumber.toString() + "</NotificationSequenceNumber>" + NL;
    s += "<SubscriptionChangeCounter>" + this.subscriptionChangeCounter.toString() + "</SubscriptionChangeCounter>" + NL;
    s += "<Add1Timestamp>" + ts + "</Add1Timestamp>" + NL;
    s += "<Add1SubscriptionChangeCounter>" + this.add1SubscriptionChangeCounter.toString() + "</Add1SubscriptionChangeCounter>" + NL;
    s += "<ValueList>" + NL;
    for (const [key, value] of this.values) {
      s += "<Value>" + NL;
      s += "<ItemRefId>" + key.toString() + "</ItemRefId>" + NL;
      s += value.toString();
      s += "</Value>" + NL;
    }
    s += "</ValueList>" + NL;

    s += "<ReturnValueList>" + NL;
    for (const [key, value] of this.returnValues) {
      s += "<ReturnValue>" + NL;
      s += "<ItemRefId>" + key.toString() + "</ItemRefId>" + NL;
      s += "<ReturnValue>" + value.toString() + "</ReturnValue>" + NL;
      s += "</ReturnValue>" + NL;
    }
    s += "</ReturnValueList>" + NL;
    // For alarm object(s)
    s += "<P2SubscriptionObjectId>" + this.p2SubscriptionObjectId.toString() + "</P2SubscriptionObjectId>" + NL;
    s += "<P2Unknown1>" + this.p2Unknown1.toString() + "</P2Unknown1>" + NL;
    s += "<P2ReturnValue>" + this.p2ReturnValue.toString() + "</P2ReturnValue>" + NL;
    s += "<P2Objects>" + NL;
    for (const p2o of this.p2Objects) {
      s += p2o.toString();
    }
    s += "</P2Objects>" + NL;
    s += "</Notification>" + NL;
    return s;
  }

  static deserializeFromPdu(pdu: ByteStream): Notification | null {
    // Special handling of ProtocolVersion, which is written to the stream before
    const protocolVersion = S7p.decodeByte(pdu);
    const opcode = S7p.decodeByte(pdu);
    if (opcode !== Opcode.Notification) {
      return null;
    }
    const notif = new Notification(protocolVersion);
    notif.deserialize(pdu);

    return notif;
  }
}
