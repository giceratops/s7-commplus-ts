/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { Ids } from "../core/Ids.js";
import { ProtocolVersion } from "../core/ProtocolVersion.js";
import { CreateObjectRequest } from "../core/CreateObjectRequest.js";
import { CreateObjectResponse } from "../core/CreateObjectResponse.js";
import { Notification } from "../core/Notification.js";
import { PObject } from "../core/PObject.js";
import {
  ValueWString, ValueUSInt, ValueUInt, ValueLInt, ValueBool, ValueUDIntArray, ValueUIntArray, ValueUDInt, ValueInt,
} from "../core/PValue.js";
import { S7Consts } from "../net/S7Consts.js";
import { AlarmsDai } from "./AlarmsDai.js";
import type { AlarmConnection } from "./BrowseAlarms.js";

/**
 * IMPORTANT!
 * This is basically a test for Alarming, how to use it, and how to later integrate this into the complete library!
 *
 * Port of Alarming/AlarmsHandler.cs (partial class S7CommPlusConnection). The per-connection state is kept here.
 *
 * Example code for testing:
 *   const h = new AlarmsHandler(conn);
 *   await h.alarmSubscriptionCreate();
 *   await h.testWaitForAlarmNotifications(20000, 3, 1033);
 *   await h.alarmSubscriptionDelete();
 */
export class AlarmsHandler {
  private alarmSubscriptionRelationId = 0x7fffc001; // TODO! Unknown value! See also Subscription.cs
  private alarmSubscriptionRefRelationId = 0x51010001; // TODO! Unknown value!
  private alarmNextCreditLimit = 0;
  private alarmSubscriptionObjectId = 0;

  constructor(private readonly conn: AlarmConnection) {}

  async alarmSubscriptionCreate(): Promise<number> {
    const conn = this.conn;
    let res: number;
    const subsobj = new PObject();
    subsobj.classId = Ids.ClassSubscription;
    subsobj.relationId = this.alarmSubscriptionRelationId;
    subsobj.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("Subscription_" + this.alarmSubscriptionRelationId.toString()));
    subsobj.addAttribute(Ids.SubscriptionFunctionClassId, new ValueUSInt(2));
    subsobj.addAttribute(Ids.SubscriptionMissedSendings, new ValueUInt(0));
    subsobj.addAttribute(Ids.SubscriptionSubsystemError, new ValueLInt(0n));
    subsobj.addAttribute(Ids.SubscriptionRouteMode, new ValueUSInt(2)); // TODO Unknown
    subsobj.addAttribute(Ids.SubscriptionActive, new ValueBool(true));
    subsobj.addAttribute(Ids.SubscriptionReferenceList, new ValueUDIntArray([0x80010000, 0, 0], 0x20)); // 0x20 = Adressarray
    subsobj.addAttribute(Ids.SubscriptionCycleTime, new ValueUDInt(0));
    subsobj.addAttribute(Ids.SubscriptionDelayTime, new ValueUDInt(0));
    subsobj.addAttribute(Ids.SubscriptionDisabled, new ValueUSInt(0));
    subsobj.addAttribute(Ids.SubscriptionCount, new ValueUSInt(0));
    this.alarmNextCreditLimit = 10;
    subsobj.addAttribute(Ids.SubscriptionCreditLimit, new ValueInt(this.alarmNextCreditLimit)); // -1=unlimited, 255 = max
    subsobj.addAttribute(Ids.SubscriptionTicks, new ValueUInt(65535)); // 65535
    // 1055 = Unknown -> is working without setting this. Maybe default attribute is zero.
    //subsobj.addAttribute(1055, new ValueUSInt(0));
    const asrefsobj = new PObject();
    asrefsobj.classId = Ids.AlarmSubscriptionRef_Class_Rid;
    asrefsobj.relationId = this.alarmSubscriptionRefRelationId;
    asrefsobj.addAttribute(Ids.ObjectVariableTypeName, new ValueWString("S7pDriver_Alarming"));
    asrefsobj.addAttribute(Ids.SubscriptionReferenceTriggerAndTransmitMode, new ValueUSInt(3));
    asrefsobj.addAttribute(Ids.AlarmSubscriptionRef_AlarmDomain, new ValueUIntArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0x10));
    // Also variant to set explicit the alarm domain as filter, for example:
    // {1, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272}
    // Possibly 65535 is "all".
    asrefsobj.addAttribute(Ids.AlarmSubscriptionRef_AlarmDomain2, new ValueUIntArray([65535], 0x20)); // 0x20 = Adressarray
    // OPTION:
    // Send text informations with the message, we don't need to browse them in advance.
    asrefsobj.addAttribute(Ids.AlarmSubscriptionRef_AlarmTextLanguages_Rid, new ValueUDIntArray([], 0x20)); // Empty for all languanges? Otherwise e.g. 1031 for de-de or what you need.
    asrefsobj.addAttribute(Ids.AlarmSubscriptionRef_SendAlarmTexts_Rid, new ValueBool(true));

    asrefsobj.addRelation(Ids.AlarmSubscriptionRef_itsAlarmSubsystem, 0x00000008);
    subsobj.addObject(asrefsobj);
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
      console.log("AlarmSubscription - Create: CreateObjectResponse with Error!");
      return S7Consts.errIsoInvalidPDU;
    }

    if (createObjRes.returnValue === 0n) {
      // Save the ObjectId, to modify the existing subscription
      this.alarmSubscriptionObjectId = createObjRes.objectIds[0];
    } else {
      // If creating a subscription fails, the object is still created and should be deleted.
      // At least deleting it, gives no error.
      console.log(
        "AlarmSubscription - Create: Failed with Returnvalue = 0x" +
          (BigInt(createObjRes.returnValue) & 0xffffffffffffffffn).toString(16).toUpperCase().padStart(8, "0"),
      );
      res = S7Consts.errCliInvalidParams;
    }

    return res;
  }

  async testWaitForAlarmNotifications(waitTimeout: number, untilNumberOfAlarms: number, alarmTextsLanguageId: number): Promise<number> {
    const conn = this.conn;
    const res = 0;
    const creditLimitStep = 5;

    for (let i = 1; i <= untilNumberOfAlarms; i++) {
      console.log("\nWaitForAlarmNotifications(): *** Loop #" + i + " ***");
      conn.lastError = 0;
      await conn.waitForNewS7plusReceived(waitTimeout);
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
          " PLC-Timestamp=" + noti.add1Timestamp.toISOString() + "." + String(noti.add1Timestamp.getUTCMilliseconds()).padStart(3, "0"),
        );

        const dai = AlarmsDai.fromNotificationObject(noti.p2Objects![0], alarmTextsLanguageId);
        console.log(String(dai));
        if (noti.notificationCreditTick >= this.alarmNextCreditLimit - 1) {
          // Set new limit one tick before it expires, to get a constant flow of data
          // CreditTick in Notification is only one byte
          this.alarmNextCreditLimit = (this.alarmNextCreditLimit + creditLimitStep) % 255;
          console.log("--> Credit limit of " + noti.notificationCreditTick + " reached. SetCreditLimit to " + this.alarmNextCreditLimit);
          await conn.subscriptionSetCreditLimit(this.alarmNextCreditLimit);
        }
      }
    }
    return res;
  }

  async alarmSubscriptionDelete(): Promise<number> {
    this.alarmSubscriptionObjectId = 0;
    console.log("SubscriptionDelete: Calling DeleteObject for SessionId2=" + this.conn.sessionId2.toString(16).toUpperCase().padStart(8, "0"));
    return await this.conn.deleteObject(this.conn.sessionId2);
  }
}
