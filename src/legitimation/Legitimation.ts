/*
 * S7CommPlusDriver - Legitimation stage of the connect routine.
 * Ported to TypeScript. In C# this is a `partial class S7CommPlusConnection`; here the functions take the
 * connection as first argument (`host`, see LegitimationHost). S7CommPlusConnection can expose thin wrappers.
 */
import { ByteStream } from "../core/ByteStream.js";
import { Ids } from "../core/Ids.js";
import { ProtocolVersion } from "../core/ProtocolVersion.js";
import { GetVarSubstreamedRequest } from "../core/GetVarSubstreamedRequest.js";
import { GetVarSubstreamedResponse } from "../core/GetVarSubstreamedResponse.js";
import { SetVariableRequest } from "../core/SetVariableRequest.js";
import { SetVariableResponse } from "../core/SetVariableResponse.js";
import { ValueBlob, ValueStruct, ValueUDInt, ValueUSIntArray, ValueWString } from "../core/PValue.js";
import { S7Consts } from "../net/S7Consts.js";
import type { S7Client } from "../net/S7Client.js";
import { AccessLevel } from "./AccessLevel.js";
import { LegitimationCrypto } from "./LegitimationCrypto.js";
import { LegitimationType } from "./LegitimationType.js";

/** What the legitimation needs from S7CommPlusConnection (members mirror the C# fields m_xxx). */
export interface LegitimationHost {
  client: S7Client; // m_client
  sessionId: number; // m_SessionId
  readTimeout: number; // m_ReadTimeout
  lastError: number; // m_LastError (read/write)
  receivedPDU: ByteStream; // m_ReceivedPDU
  /** OMS secret, rolled by legitimateNew (C# field omsSecret). */
  omsSecret: Uint8Array | null;
  sendS7plusFunctionObject(obj: GetVarSubstreamedRequest | SetVariableRequest): Promise<number>;
  waitForNewS7plusReceived(timeoutMs: number): Promise<void>;
}

const enc = new TextEncoder();

/**
 * Legitimation stage of the connect routine
 * @param serverSession Server session information containing the firmware version
 * @param password PLC password
 * @param username PLC username (leave empty for legacy login)
 * @returns error code (0 = ok)
 */
export async function legitimate(
  host: LegitimationHost,
  serverSession: ValueStruct,
  password: string,
  username = "",
): Promise<number> {
  // S7-1214C  (6ES7 214-1AG40-0XB0)           1;6ES7 214-1AG40-0XB0 ;V4.5
  // S7-1510SP (6ES7 510-1DJ01-0AB0)           1;6ES7 510-1DJ01-0AB0;V2.9
  // S7-1507SF (6ES7 672-7FC01-0YA0)           1;6ES7 672-7FC01-0YA0;V21.9

  // Parse device and firmware version
  // Secure PG/HMI communication (TLS) is supported starting with TIA Portal V17:
  //  S7-1500 as of V2.9, S7-1200 as of V4.5, software controllers as of V21.9, SIMATIC Drive controllers as of V2.9,
  //  PLCSim and PLCSim Advanced V4.0.
  const sessionVersionPAOMString = (
    serverSession.getStructElement(Ids.LID_SessionVersionSystemPAOMString) as ValueWString
  ).getValue();
  const reVersions = /^[^;]*;[^;]*[17]\s?(\d{3}).*;[VS](\d{1,2}\.\d+)$/i;
  const m = reVersions.exec(sessionVersionPAOMString);
  if (m === null) {
    console.log("S7CommPlusConnection - Legitimate: Could not extract firmware version!");
    return S7Consts.errCliFirmwareNotSupported;
  }
  const deviceVersion = m[1]; // e.g., "672"
  const firmwareVersion = m[2]; // e.g., "21.9"

  // Compute fwVerNo = major*100 + minor (e.g., "21.9" -> 2109)
  let fwVerNo: number;
  {
    const parts = firmwareVersion.split(".");
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || isNaN(major) || isNaN(minor)) {
      console.log(`S7CommPlusConnection - Legitimate: Invalid firmware format: ${firmwareVersion}`);
      return S7Consts.errCliFirmwareNotSupported;
    }
    fwVerNo = major * 100 + minor;
  }

  // Check if we have to use legacy legitimation via the firmware version
  let legacyLegitimation = false;
  if (deviceVersion.startsWith("5")) {
    // S7-1500 (5xx)
    if (fwVerNo < 209) {
      console.log("S7CommPlusConnection - Legitimate: Firmware version is not supported!");
      return S7Consts.errCliFirmwareNotSupported;
    }
    if (fwVerNo < 301) {
      legacyLegitimation = true;
    }
  } else if (sessionVersionPAOMString.includes("50-0XB0") && deviceVersion.startsWith("2")) {
    // New S7-1200 G2 (example: "1;6ES7 212-1HG50-0XB0;V1.0")
    legacyLegitimation = false;
  } else if (deviceVersion.startsWith("2")) {
    // S7-1200 (2xx)
    if (fwVerNo < 403) {
      console.log("S7CommPlusConnection - Legitimate: Firmware version is not supported!");
      return S7Consts.errCliFirmwareNotSupported;
    }
    if (fwVerNo < 407) {
      legacyLegitimation = true;
    }
  } else if (deviceVersion.startsWith("6")) {
    // S7-1507S (6xx)
    if (fwVerNo < 2109) {
      console.log("S7CommPlusConnection - Legitimate: Firmware version is not supported!");
      return S7Consts.errCliFirmwareNotSupported;
    }
    legacyLegitimation = true;
  } else {
    console.log("S7CommPlusConnection - Legitimate: Device version is not supported!");
    return S7Consts.errCliDeviceNotSupported;
  }

  // Get current protection level
  const getVarSubstreamedReq = new GetVarSubstreamedRequest(ProtocolVersion.V2);
  getVarSubstreamedReq.inObjectId = host.sessionId;
  getVarSubstreamedReq.sessionId = host.sessionId;
  getVarSubstreamedReq.address = Ids.EffectiveProtectionLevel;
  const res = await host.sendS7plusFunctionObject(getVarSubstreamedReq);
  if (res !== 0) {
    host.client.disconnect();
    return res;
  }
  host.lastError = 0;
  await host.waitForNewS7plusReceived(host.readTimeout);
  if (host.lastError !== 0) {
    host.client.disconnect();
    return host.lastError;
  }

  const getVarSubstreamedRes = GetVarSubstreamedResponse.deserializeFromPdu(host.receivedPDU);
  if (getVarSubstreamedRes === null) {
    console.log("S7CommPlusConnection - Legitimate: GetVarSubstreamedResponse with Error!");
    host.client.disconnect();
    return S7Consts.errIsoInvalidPDU;
  }

  // Check access level
  const accessLevel = (getVarSubstreamedRes.value as ValueUDInt).getValue();
  if (accessLevel > AccessLevel.FullAccess && password !== "") {
    // Legitimate
    if (legacyLegitimation) {
      return legitimateLegacy(host, password);
    } else {
      return legitimateNew(host, password, username);
    }
  } else if (accessLevel > AccessLevel.FullAccess) {
    console.log("S7CommPlusConnection - Legitimate: Warning: Access level is not fullaccess but no password set!");
  }

  return 0;
}

/** Requests the legitimation challenge. Returns error code or the challenge. */
async function getChallenge(host: LegitimationHost): Promise<{ res: number; challenge: Uint8Array }> {
  const req = new GetVarSubstreamedRequest(ProtocolVersion.V2);
  req.inObjectId = host.sessionId;
  req.sessionId = host.sessionId;
  req.address = Ids.ServerSessionRequest;
  const res = await host.sendS7plusFunctionObject(req);
  if (res !== 0) {
    host.client.disconnect();
    return { res, challenge: new Uint8Array(0) };
  }
  host.lastError = 0;
  await host.waitForNewS7plusReceived(host.readTimeout);
  if (host.lastError !== 0) {
    host.client.disconnect();
    return { res: host.lastError, challenge: new Uint8Array(0) };
  }
  const r = GetVarSubstreamedResponse.deserializeFromPdu(host.receivedPDU);
  if (r === null) {
    console.log("S7CommPlusConnection - Legitimate: getVarSubstreamedRes_challenge with Error!");
    host.client.disconnect();
    return { res: S7Consts.errIsoInvalidPDU, challenge: new Uint8Array(0) };
  }
  return { res: 0, challenge: (r.value as ValueUSIntArray).getValue() };
}

/** Sends the SetVariable with the response and evaluates the result. */
async function sendResponse(host: LegitimationHost, address: number, value: ValueBlob | ValueUSIntArray): Promise<number> {
  const setVariableReq = new SetVariableRequest(ProtocolVersion.V2);
  setVariableReq.inObjectId = host.sessionId;
  setVariableReq.sessionId = host.sessionId;
  setVariableReq.address = address;
  setVariableReq.value = value;
  const res = await host.sendS7plusFunctionObject(setVariableReq);
  if (res !== 0) {
    host.client.disconnect();
    return res;
  }
  host.lastError = 0;
  await host.waitForNewS7plusReceived(host.readTimeout);
  if (host.lastError !== 0) {
    host.client.disconnect();
    return host.lastError;
  }

  const setVariableResponse = SetVariableResponse.deserializeFromPdu(host.receivedPDU);
  if (setVariableResponse === null) {
    console.log("S7CommPlusConnection - Legitimate: setVariableResponse with Error!");
    host.client.disconnect();
    return S7Consts.errIsoInvalidPDU;
  }
  // Check if the legitimation attempt was successful
  const errorCode = Number(BigInt.asIntN(16, BigInt(setVariableResponse.returnValue)));
  if (errorCode < 0) {
    console.log("S7CommPlusConnection - Legitimate: access denied");
    host.client.disconnect();
    return S7Consts.errCliAccessDenied;
  }
  return 0;
}

/**
 * Legitimate using the new login method (firmware >= 3.1)
 * @param password PLC password
 * @param username PLC username (leave empty for legacy login)
 * @returns error code (0 = ok)
 */
export async function legitimateNew(host: LegitimationHost, password: string, username = ""): Promise<number> {
  // Get challenge
  const c = await getChallenge(host);
  if (c.res !== 0) return c.res;
  const challenge = c.challenge;

  // Encrypt challengeResponse
  if (host.omsSecret === null || host.omsSecret.length !== 32) {
    // Create oms exporter secret
    host.omsSecret = host.client.getOMSExporterSecret();
  }
  // Roll key
  const key = LegitimationCrypto.sha256(host.omsSecret as Uint8Array);
  host.omsSecret = key;

  // Use the first 16 bytes of the challenge as iv
  const iv = challenge.slice(0, 16);
  // Encrypt
  const challengeResponse = LegitimationCrypto.encryptAesCbc(buildLegitimationPayload(password, username), key, iv);

  // Send challengeResponse
  return sendResponse(host, Ids.Legitimate, new ValueBlob(0, challengeResponse));
}

/**
 * Builds the legitimation payload from given username and password.
 * If username is empty the payload for a legacy login will be build.
 * If username is not empty the payload for the new login is build.
 */
export function buildLegitimationPayload(password: string, username = ""): Uint8Array {
  const payload = new ValueStruct(Ids.LID_LegitimationPayloadStruct);
  if (username !== "") {
    // Login with username and password = new login
    payload.addStructElement(Ids.LID_LegitimationPayloadType, new ValueUDInt(LegitimationType.New));
    payload.addStructElement(Ids.LID_LegitimationPayloadUsername, new ValueBlob(0, enc.encode(username)));
    payload.addStructElement(Ids.LID_LegitimationPayloadPassword, new ValueBlob(0, enc.encode(password)));
  } else {
    // Login with only password = legacy login
    // Hash password
    const hashedPw = LegitimationCrypto.sha1(enc.encode(password));
    payload.addStructElement(Ids.LID_LegitimationPayloadType, new ValueUDInt(LegitimationType.Legacy));
    payload.addStructElement(Ids.LID_LegitimationPayloadUsername, new ValueBlob(0, enc.encode(username)));
    payload.addStructElement(Ids.LID_LegitimationPayloadPassword, new ValueBlob(0, hashedPw));
  }
  const memStr = new ByteStream();
  payload.serialize(memStr);
  return memStr.toArray();
}

/**
 * Legitimate using the old legacy login (firmware version < 3.1)
 * @param password PLC password
 * @returns error code (0 = OK)
 */
export async function legitimateLegacy(host: LegitimationHost, password: string): Promise<number> {
  // Get challenge
  const c = await getChallenge(host);
  if (c.res !== 0) return c.res;
  const challenge = c.challenge;

  // Calculate challengeResponse [sha1(password) xor challenge]
  const challengeResponse = LegitimationCrypto.sha1(enc.encode(password)).slice();
  if (challengeResponse.length !== challenge.length) {
    console.log("S7CommPlusConnection - Legitimate: challengeResponse.Length != challenge.Length");
    host.client.disconnect();
    return S7Consts.errIsoInvalidPDU;
  }
  for (let i = 0; i < challengeResponse.length; ++i) {
    challengeResponse[i] = (challengeResponse[i] ^ challenge[i]) & 0xff;
  }

  // Send challengeResponse
  return sendResponse(host, Ids.ServerSessionResponse, new ValueUSIntArray(challengeResponse));
}
