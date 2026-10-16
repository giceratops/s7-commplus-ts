/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */

export const Functioncode = {
  Error: 0x04b1,
  Explore: 0x04bb,
  CreateObject: 0x04ca,
  DeleteObject: 0x04d4,
  SetVariable: 0x04f2,
  GetVariable: 0x04fc,
  AddLink: 0x0506,
  RemoveLink: 0x051a,
  GetLink: 0x0524,
  SetMultiVariables: 0x0542,
  GetMultiVariables: 0x054c,
  BeginSequence: 0x0556,
  EndSequence: 0x0560,
  Invoke: 0x056b,
  SetVarSubStreamed: 0x057c,
  GetVarSubStreamed: 0x0586,
  GetVariablesAddress: 0x0590,
  Abort: 0x059a,
  Error2: 0x05a9,
  InitSsl: 0x05b3,
} as const;
export type Functioncode = (typeof Functioncode)[keyof typeof Functioncode];
