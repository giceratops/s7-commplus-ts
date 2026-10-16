/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de
 * Licensed under the GNU Lesser General Public License v3 or later.
 * Ported to TypeScript.
 */
import type { ByteStream } from "./ByteStream.js";

export interface IS7pRequest {
  serialize(buffer: ByteStream): number;
  sessionId: number;
  protocolVersion: number;
  readonly functionCode: number;
  sequenceNumber: number;
  integrityId: number;
  withIntegrityId: boolean;
}
