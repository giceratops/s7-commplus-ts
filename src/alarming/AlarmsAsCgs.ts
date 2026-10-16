/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { Ids } from "../core/Ids.js";
import { ValueStruct, ValueUSInt, ValueTimestamp, ValueBlobArray } from "../core/PValue.js";
import { Utils } from "../core/Utils.js";
import { AlarmsAssociatedValues } from "./AlarmsAssociatedValues.js";

const NL = "\n";

export const SubtypeIds = {
  Coming: Ids.DAI_Coming,
  Going: Ids.DAI_Going,
} as const;

function subtypeIdName(id: number): string {
  for (const [k, v] of Object.entries(SubtypeIds)) if (v === id) return k;
  return String(id);
}

export class AlarmsAsCgs {
  subtypeId = 0; // This is not part of the class, but is neccessary to store the information: 2673 = DAI.Coming, 2677 = DAI.Going

  allStatesInfo = 0;
  timestamp: Date = new Date(0);
  associatedValues!: AlarmsAssociatedValues;
  ackTimestamp: Date = new Date(0);

  toString(): string {
    let s = "<AlarmsAsCgs>" + NL;
    s += "<SubtypeId>" + this.subtypeId + "</SubtypeId>" + NL;
    s += "<SubtypeIdName>" + subtypeIdName(this.subtypeId) + "</SubtypeIdName>" + NL;
    s += "<AllStatesInfo>" + this.allStatesInfo + "</AllStatesInfo>" + NL;
    s += "<AssociatedValues>" + NL + this.associatedValues.toString() + "</AssociatedValues>" + NL;
    s += "<Timestamp>" + this.timestamp.toISOString() + "</Timestamp>" + NL;
    s += "<AckTimestamp>" + this.ackTimestamp.toISOString() + "</AckTimestamp>" + NL;
    s += "</AlarmsAsCgs>" + NL;
    return s;
  }

  static fromValueStruct(str: ValueStruct): AlarmsAsCgs {
    const asCgs = new AlarmsAsCgs();
    asCgs.allStatesInfo = (str.getStructElement(Ids.AS_CGS_AllStatesInfo) as ValueUSInt).getValue();
    asCgs.timestamp = Utils.dtFromValueTimestamp((str.getStructElement(Ids.AS_CGS_Timestamp) as ValueTimestamp).getValue());
    asCgs.associatedValues = AlarmsAssociatedValues.fromValueBlob(str.getStructElement(Ids.AS_CGS_AssociatedValues) as ValueBlobArray);
    asCgs.ackTimestamp = Utils.dtFromValueTimestamp((str.getStructElement(Ids.AS_CGS_AckTimestamp) as ValueTimestamp).getValue());
    return asCgs;
  }
}
