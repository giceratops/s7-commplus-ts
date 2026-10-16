/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import { ItemAddress } from "../clientapi/ItemAddress.js";
import type { S7CommPlusConnection } from "../S7CommPlusConnection.js";
import { Ids } from "./Ids.js";
import { ValueDInt } from "./PValue.js";

const NL = "\n";

/** C#: `((ValueDInt)values[i]).GetValue()` throws InvalidCastException for any other value type. */
function castDInt(v: unknown): number {
  if (!(v instanceof ValueDInt)) {
    throw new TypeError("Unable to cast object of type '" + (v as object).constructor.name + "' to type 'ValueDInt'.");
  }
  return v.getValue();
}

export class CommRessources {
  tagsPerReadRequestMax = 20;
  tagsPerWriteRequestMax = 20;
  plcAttributesMax = 0;
  plcAttributesFree = 0;
  plcSubscriptionsMax = 0;
  plcSubscriptionsFree = 0;
  subscriptionMemoryMax = 0;
  subscriptionMemoryFree = 0;

  async readMax(conn: S7CommPlusConnection): Promise<number> {
    // Read SystemLimits
    // Assumption (so far, because for all CPUs which have be seen both values were the same):
    // 1000 = Number for Reading
    // 1001 = Number for Writing
    const adrTagsPerReadRequestMax = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
    adrTagsPerReadRequestMax.lid.push(1000);

    const adrTagsPerWriteRequestMax = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
    adrTagsPerWriteRequestMax.lid.push(1001);

    const adrPlcSubscriptionsMax = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
    adrPlcSubscriptionsMax.lid.push(0);

    const adrPlcAttributesMax = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
    adrPlcAttributesMax.lid.push(1);

    const adrSubscriptionMemoryMax = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
    adrSubscriptionMemoryMax.lid.push(2);

    const readlist: ItemAddress[] = [
      adrTagsPerReadRequestMax,
      adrTagsPerWriteRequestMax,
      adrPlcSubscriptionsMax,
      adrPlcAttributesMax,
      adrSubscriptionMemoryMax,
    ];

    const { res, values, errors } = await conn.readValues(readlist);
    for (let i = 0; i < values.length; i++) {
      if (values[i] != null && errors[i] === 0n) {
        const v = castDInt(values[i]);
        switch (i) {
          case 0:
            this.tagsPerReadRequestMax = v;
            break;
          case 1:
            this.tagsPerWriteRequestMax = v;
            break;
          case 2:
            this.plcSubscriptionsMax = v;
            break;
          case 3:
            this.plcAttributesMax = v;
            break;
          case 4:
            this.subscriptionMemoryMax = v;
            break;
        }
      }
    }
    return res;
  }

  async readFree(conn: S7CommPlusConnection): Promise<number> {
    const adrPlcSubscriptionsFree = new ItemAddress(Ids.ObjectRoot, Ids.FreeItems);
    adrPlcSubscriptionsFree.lid.push(0);

    const adrPlcAttributesFree = new ItemAddress(Ids.ObjectRoot, Ids.FreeItems);
    adrPlcAttributesFree.lid.push(1);

    const adrSubscriptionMemoryFree = new ItemAddress(Ids.ObjectRoot, Ids.FreeItems);
    adrSubscriptionMemoryFree.lid.push(2);

    const readlist: ItemAddress[] = [adrPlcSubscriptionsFree, adrPlcAttributesFree, adrSubscriptionMemoryFree];

    const { res, values, errors } = await conn.readValues(readlist);
    for (let i = 0; i < values.length; i++) {
      if (values[i] != null && errors[i] === 0n) {
        const v = castDInt(values[i]);
        switch (i) {
          case 0:
            this.plcSubscriptionsFree = v;
            break;
          case 1:
            this.plcAttributesFree = v;
            break;
          case 2:
            this.subscriptionMemoryFree = v;
            break;
        }
      }
    }
    return res;
  }

  toString(): string {
    let s = "<CommRessources>" + NL;
    s += "<TagsPerReadRequestMax>" + this.tagsPerReadRequestMax.toString() + "</TagsPerReadRequestMax>" + NL;
    s += "<TagsPerWriteRequestMax>" + this.tagsPerWriteRequestMax.toString() + "</TagsPerWriteRequestMax>" + NL;
    s += "<PlcAttributesMax>" + this.plcAttributesMax.toString() + "</PlcAttributesMax>" + NL;
    s += "<PlcAttributesFree>" + this.plcAttributesFree.toString() + "</PlcAttributesFree>" + NL;
    s += "<PlcSubscriptionsMax>" + this.plcSubscriptionsMax.toString() + "</PlcSubscriptionsMax>" + NL;
    s += "<PlcSubscriptionsFree>" + this.plcSubscriptionsFree.toString() + "</PlcSubscriptionsFree>" + NL;
    s += "<SubscriptionMemoryMax>" + this.subscriptionMemoryMax.toString() + "</SubscriptionMemoryMax>" + NL;
    s += "<SubscriptionMemoryFree>" + this.subscriptionMemoryFree.toString() + "</SubscriptionMemoryFree>" + NL;
    s += "</CommRessources>" + NL;
    return s;
  }
}
