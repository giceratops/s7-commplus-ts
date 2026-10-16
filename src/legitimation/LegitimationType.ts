// Ported to TypeScript from S7CommPlusDriver (Thomas Wiens, LGPL).
export const LegitimationType = {
  Legacy: 1,
  New: 2,
} as const;
export type LegitimationType = (typeof LegitimationType)[keyof typeof LegitimationType];
