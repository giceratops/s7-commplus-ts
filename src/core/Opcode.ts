/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

export const Opcode = {
  Request: 0x31,
  Response: 0x32,
  Notification: 0x33,
  Response2: 0x02,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];
