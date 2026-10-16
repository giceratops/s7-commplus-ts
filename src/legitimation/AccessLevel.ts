// Ported to TypeScript from S7CommPlusDriver (Thomas Wiens, LGPL).
export const AccessLevel = {
  FullAccess: 1,
  ReadAccess: 2,
  HMIAccess: 3,
  NoAccess: 4,
} as const;
export type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];
