/*
 * S7CommPlusDriver
 * Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

import { ValueBlobSparseArray } from "../core/PValue.js";
import { Utils } from "../core/Utils.js";

const NL = "\n";

export class AlarmsAlarmTexts {
  languageId = 0;
  infotext = "";
  alarmText = "";
  additionalText1 = "";
  additionalText2 = "";
  additionalText3 = "";
  additionalText4 = "";
  additionalText5 = "";
  additionalText6 = "";
  additionalText7 = "";
  additionalText8 = "";
  additionalText9 = "";

  // These two values we get in addition when browsing for the alarmtexts
  // Don't know if they are useful for something.
  unknownValue1 = 0;
  unknownValue2 = 0;

  static fromNotificationBlob(blob: ValueBlobSparseArray, languageId: number): AlarmsAlarmTexts {
    const at = new AlarmsAlarmTexts();
    at.languageId = languageId;
    for (const [key, entry] of blob.value) {
      const s = Utils.getUtfString(entry.value!, 0, entry.value!.length);
      // Values in older CPUs, from: 0xa09c8001..0xa09c800b (2694610945..2694610955)
      // Current CPUs use:           0x04070001..0x0407000b (  67567617..  67567627)
      // Where the left word is the language ID, 0x0407 = 1031, and the right word is the text id.
      // The blob may contain several languages. If you need them all, you need to call this multiple times.
      const lcid = (key >>> 16) | 0;
      const textid = (key & 0xffff) | 0;
      if (lcid === languageId) {
        switch (textid) {
          case 1: at.infotext = s; break;
          case 2: at.alarmText = s; break;
          case 3: at.additionalText1 = s; break;
          case 4: at.additionalText2 = s; break;
          case 5: at.additionalText3 = s; break;
          case 6: at.additionalText4 = s; break;
          case 7: at.additionalText5 = s; break;
          case 8: at.additionalText6 = s; break;
          case 9: at.additionalText7 = s; break;
          case 10: at.additionalText8 = s; break;
          case 11: at.additionalText9 = s; break;
        }
      }
    }
    return at;
  }

  toString(): string {
    let s = '<AlarmsAlarmTexts LanguageId="' + this.languageId + '">' + NL;
    s += "<Infotext>" + this.infotext + "</Infotext>" + NL;
    s += "<AlarmText>" + this.alarmText + "</AlarmText>" + NL;
    s += "<AdditionalText1>" + this.additionalText1 + "</AdditionalText1>" + NL;
    s += "<AdditionalText2>" + this.additionalText2 + "</AdditionalText2>" + NL;
    s += "<AdditionalText3>" + this.additionalText3 + "</AdditionalText3>" + NL;
    s += "<AdditionalText4>" + this.additionalText4 + "</AdditionalText4>" + NL;
    s += "<AdditionalText5>" + this.additionalText5 + "</AdditionalText5>" + NL;
    s += "<AdditionalText6>" + this.additionalText6 + "</AdditionalText6>" + NL;
    s += "<AdditionalText7>" + this.additionalText7 + "</AdditionalText7>" + NL;
    s += "<AdditionalText8>" + this.additionalText8 + "</AdditionalText8>" + NL;
    s += "<AdditionalText9>" + this.additionalText9 + "</AdditionalText9>" + NL;
    s += "</AlarmsAlarmTexts>" + NL;
    return s;
  }
}
