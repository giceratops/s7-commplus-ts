/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

export const Datatype = {
  Null: 0x00,
  Bool: 0x01,
  USInt: 0x02,
  UInt: 0x03,
  UDInt: 0x04,
  ULInt: 0x05,
  SInt: 0x06,
  Int: 0x07,
  DInt: 0x08,
  LInt: 0x09,
  Byte: 0x0a,
  Word: 0x0b,
  DWord: 0x0c,
  LWord: 0x0d,
  Real: 0x0e,
  LReal: 0x0f,
  Timestamp: 0x10,
  Timespan: 0x11,
  RID: 0x12,
  AID: 0x13,
  Blob: 0x14,
  WString: 0x15,
  Variant: 0x16,
  Struct: 0x17,
  S7String: 0x19,
} as const;
export type Datatype = (typeof Datatype)[keyof typeof Datatype];
