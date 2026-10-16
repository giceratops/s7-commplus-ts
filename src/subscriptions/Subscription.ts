/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */
import type { ByteStream } from "../core/ByteStream.js";
import { Ids } from "../core/Ids.js";
import { ProtocolVersion } from "../core/ProtocolVersion.js";
import { CreateObjectRequest } from "../core/CreateObjectRequest.js";
import { CreateObjectResponse } from "../core/CreateObjectResponse.js";
import { SetVariableRequest } from "../core/SetVariableRequest.js";
import { Notification } from "../core/Notification.js";
import { PObject } from "../core/PObject.js";
import {
  ValueWString,
  ValueUSInt,
  ValueUInt,
  ValueLInt,
  ValueBool,
  ValueUDInt,
  ValueInt,
  ValueUDIntArray,
} from "../core/PValue.js";
import { S7Consts } from "../net/S7Consts.js";
import type { PlcTag } from "../clientapi/PlcTag.js";
import type { S7CommPlusConnection } from "../S7CommPlusConnection.js";

/**
 * The C# subscription code is part of the partial class S7CommPlusConnection and uses its internal members.
 * This describes the (camelCase) members of the connection it relies on.
 */
export interface SubscriptionConnection {
  readonly sessionId2: number;
  readTimeout: number;
  lastError: number;
  receivedPDU: ByteStream;
  client: { disconnect(): void };
  sendS7plusFunctionObject(obj: unknown): Promise<number>;
  waitForNewS7plusReceived(timeout: number): Promise<void>;
  deleteObject(objectId: number): Promise<number>;
}

/** Cast helper: the real connection class provides these members. */
export function asSubscriptionConnection(conn: S7CommPlusConnection): SubscriptionConnection {
  return conn as unknown as SubscriptionConnection;
}

function hex8(n: number | bigint): string {
  return n.toString(16).toUpperCase().padStart(8, "0");
}

export class Subscription {
  // *************************************************
  // *                IMPORTANT!                     *
  // * This is basically a test for subscriptions,   *
  // * how to use them, and how to later integrate   *
  // * this into the complete library!               *
  // *************************************************
  // Port of Subscriptions/Subscription.cs (partial class S7CommPlusConnection). The per-connection state is kept here.

  private subscribedTags = new Map<number, PlcTag>(); // ItemRefId
  private subcriptionChangeCounter = 1;
  // TODO! Unknown value!0x7fffc001. Seems to be a startvalue, increases on next CreateObject. Guess: It's stored in the plc under this id.
  private subscriptionRelationId = 0x7fffc001;
  private nextCreditLimit = 0;
  private subscriptionObjectId = 0;

  constructor(private readonly conn: SubscriptionConnection) {}

  /**
   * Creates a subscription
   * @param plcTags The list of tags to add to the subscription
   * @param cycleTime Cycle time for update in milliseconds. Lowest value seems to be 100 ms (if it's not dependant on the CPU).
   */
  async subscriptionCreate(plcTags: PlcTag[], cycleTime: number): Promise<number> {
    const conn = this.conn;
    let res: number;
    this.subscribedTags = new Map<number, PlcTag>();
    const subsobj = new PObject();
    subsobj.classId = Ids.ClassSubscription;
    subsobj.relationId = this.subscriptionRelationId;
    subsobj.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("Subscription_" + this.subscriptionRelationId.toString()));
    subsobj.addAttribute(Ids.SubscriptionFunctionClassId, new ValueUSInt(0));
    subsobj.addAttribute(Ids.SubscriptionMissedSendings, new ValueUInt(0));
    subsobj.addAttribute(Ids.SubscriptionSubsystemError, new ValueLInt(0n));
    subsobj.addAttribute(Ids.SubscriptionRouteMode, new ValueUSInt(0x14)); // TODO Unknown, mostly seen 0x04, 0x14 or 0x15. Needs to be tested

    // Testresults of some RouteModes (0x04, 0x14, 0x20) some applications are using, together with credit limits:
    // For Alarm Subscription RouteMode 0x02 is used.
    //-----------+-------------+-----------------------------------------------------------------------------------------------------------------------------------------------------------------
    // RouteMode | CreditLimit | Behaviour
    //-----------+-------------+-----------------------------------------------------------------------------------------------------------------------------------------------------------------
    // 0x00      |  0          | No notification at all
    // 0x00      | -1          | All values on create; then values that have changed, empty Notification each cycle; unlimited without retriggering; CreditTick always 0
    // 0x00      | n>0         | All values on create; then values that have changed, empty Notification each cycle; stops after CreditTick reaches difference of n when not set to new value
    // 0x04      | 0           | Identical to 0x00 / 0
    // 0x04      | -1          | Identical to 0x00 / -1
    // 0x04      | n>0         | Identical to 0x00 / n>0
    // 0x14      | 0           | Identical to 0x00 / 0
    // 0x14      | -1          | Identical to 0x00 / -1
    // 0x14      | n>0         | Identical to 0x00 / n>0
    // 0x20      | 0           | Identical to 0x00 / 0
    // 0x20      | -1          | All values on create; then values that have changed, on cycle without change no notification; unlimited without retriggering; CreditTick always 0
    // 0x20      | n>0         | All values on create; then values that have changed, on cycle without change no notification; stops after CreditTick reaches difference of n when not set to new value

    subsobj.addAttribute(Ids.SubscriptionActive, new ValueBool(true));
    subsobj.addAttribute(Ids.SubscriptionReferenceList, this.getSubscriptionListArray(plcTags));
    subsobj.addAttribute(Ids.SubscriptionCycleTime, new ValueUDInt(cycleTime));
    subsobj.addAttribute(Ids.SubscriptionDisabled, new ValueUSInt(0));
    subsobj.addAttribute(Ids.SubscriptionCount, new ValueUSInt(0));
    this.nextCreditLimit = 10;
    subsobj.addAttribute(Ids.SubscriptionCreditLimit, new ValueInt(this.nextCreditLimit)); // -1=unlimited, 255 = max
    subsobj.addAttribute(Ids.SubscriptionTicks, new ValueUInt(65535));
    // 1055 = Unknown -> is working without setting this.
    subsobj.addAttribute(1055, new ValueUSInt(0));

    // Build the request object
    const createObjReq = new CreateObjectRequest(ProtocolVersion.V2, 0, true);
    createObjReq.transportFlags = 0x34;
    createObjReq.requestId = conn.sessionId2;
    createObjReq.requestValue = new ValueUDInt(0);
    createObjReq.setRequestObject(subsobj);

    // Send it
    res = await conn.sendS7plusFunctionObject(createObjReq);
    if (res !== 0) {
      conn.client.disconnect();
      return res;
    }
    conn.lastError = 0;
    await conn.waitForNewS7plusReceived(conn.readTimeout);
    if (conn.lastError !== 0) {
      conn.client.disconnect();
      return conn.lastError;
    }

    const createObjRes = CreateObjectResponse.deserializeFromPdu(conn.receivedPDU);
    if (createObjRes == null) {
      console.log("Subscription - Create: CreateObjectResponse with Error!");
      return S7Consts.errIsoInvalidPDU;
    }

    if (createObjRes.returnValue === 0n) {
      // Save the ObjectId, to modify the existing subscription if needed
      this.subscriptionObjectId = createObjRes.objectIds[0];
    } else {
      // If creating a subscription fails, the object is still created and should be deleted.
      // At least deleting it, gives no error.
      console.log("Subscription - Create: Failed with Returnvalue = 0x" + hex8(createObjRes.returnValue));
      res = S7Consts.errCliInvalidParams;
    }
    return res;
  }

  /** (private in C#; public here because the alarm handler calls it on the connection as well) */
  async subscriptionSetCreditLimit(limit: number): Promise<number> {
    const setVarReq = new SetVariableRequest(ProtocolVersion.V2);
    setVarReq.transportFlags = 0x74; // Set flag, that we need no response
    setVarReq.inObjectId = this.subscriptionObjectId;
    setVarReq.address = Ids.SubscriptionCreditLimit;
    setVarReq.value = new ValueInt(limit);
    return await this.conn.sendS7plusFunctionObject(setVarReq);
  }

  private getSubscriptionListArray(plcTags: PlcTag[]): ValueUDIntArray {
    const la: number[] = [];
    // 0x8?ssxxxx = 8 = flag CreateNew, ss = 1 byte subscription Change counter, xxxx = unknown
    la.push((0x80000000 | (this.subcriptionChangeCounter << 16)) >>> 0);
    la.push(0); // Number of items to unsubscribe
    la.push(plcTags.length); // Number of items to subscribe

    let tagReferenceId = 1;
    let head: number;
    for (const tag of plcTags) {
      // Save the reference Id in the dictionary. In the notification we get this reference Id back
      // and know to which tag the value belongs to.
      if (this.subscribedTags.has(tagReferenceId)) {
        throw new Error("An item with the same key has already been added. Key: " + tagReferenceId);
      }
      this.subscribedTags.set(tagReferenceId, tag);
      // Write the Item address
      head = 0x80040000;
      // It's not known where 0x8004 stands for -> 4 was a guess it's for the number of fields
      // before the LIDs, but that's wrong (coincidentally fits here in this special case).
      // Get the number of IDs in advance, Sub-Area counts as one, and then count each LID.
      // 0x8aaabbbb = aaa = unknown value, bbbb = number of fields in the 2nd part.
      head = (head | (1 + tag.address.lid.length)) >>> 0;
      la.push(head);
      la.push(tagReferenceId);
      la.push(0); // Unknown 1
      la.push(tag.address.accessArea);
      la.push(tag.address.symbolCrc);
      // Count value in head starts from here
      la.push(tag.address.accessSubArea);
      for (const li of tag.address.lid) {
        la.push(li);
      }
      tagReferenceId++;
    }
    // Convert all data to protocol UDInt Array (VLQ encoded)
    return new ValueUDIntArray(la, 0x20); // 0x20 -> Adressarray
  }

  async testWaitForVariableChangeNotifications(untilNumberOfNotifications: number): Promise<number> {
    const conn = this.conn;
    const res = 0;
    const creditLimitStep = 5;

    for (let i = 1; i <= untilNumberOfNotifications; i++) {
      console.log("\nWaitForNotifications(): *** Loop #" + i.toString() + " ***");
      conn.lastError = 0;
      await conn.waitForNewS7plusReceived(5000);
      if (conn.lastError !== 0) {
        return conn.lastError;
      }

      const noti = Notification.deserializeFromPdu(conn.receivedPDU);
      if (noti == null) {
        console.log("Notification == null!");
        return S7Consts.errIsoInvalidPDU;
      } else {
        console.log("Notification: CreditTick=" + noti.notificationCreditTick + " SequenceNumber=" + noti.notificationSequenceNumber);
        console.log(
          " PLC-Timestamp=" + noti.add1Timestamp.toISOString() + "." + String(noti.add1Timestamp.getUTCMilliseconds()).padStart(3, "0") +
            " ValuesCount=" + noti.values.size,
        );
        for (const [key, value] of noti.values) {
          console.log("---> key=" + key + " value=" + value.toString());
          // Error value in tags expects a 64 bit value, in subscriptions it's only 1 byte (for it's not known what all values are for -> TODO)
          this.subscribedTags.get(key)!.processReadResult(value, 0n);
        }

        if (noti.notificationCreditTick >= this.nextCreditLimit - 1) {
          // Set new limit one tick before it expires, to get a constant flow of data
          // CreditTick in Notification is only one byte
          this.nextCreditLimit = (this.nextCreditLimit + creditLimitStep) % 255;
          console.log("--> Credit limit of " + noti.notificationCreditTick + " reached. SetCreditLimit to " + this.nextCreditLimit.toString());
          await this.subscriptionSetCreditLimit(this.nextCreditLimit);
        }
      }
    }
    return res;
  }

  async subscriptionDelete(): Promise<number> {
    this.subscribedTags.clear();
    this.subscriptionObjectId = 0;
    console.log("SubscriptionDelete: Calling DeleteObject for SessionId2=" + hex8(this.conn.sessionId2));
    return await this.conn.deleteObject(this.conn.sessionId2);
  }
}
