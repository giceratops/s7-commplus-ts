/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

export const ProtocolVersion = {
  V1: 0x01,
  V2: 0x02,
  V3: 0x03,
  SystemEvent: 0xfe,
} as const;
export type ProtocolVersion = (typeof ProtocolVersion)[keyof typeof ProtocolVersion];
