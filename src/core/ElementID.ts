/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

export const ElementID = {
  StartOfObject: 0xa1,
  TerminatingObject: 0xa2,
  Attribute: 0xa3,
  Relation: 0xa4,
  StartOfTagDescription: 0xa7,
  TerminatingTagDescription: 0xa8,
  VartypeList: 0xab,
  VarnameList: 0xac,
} as const;
export type ElementID = (typeof ElementID)[keyof typeof ElementID];
