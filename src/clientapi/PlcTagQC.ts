/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */

// Tag Quality Codes, based on OPC DA
// Quality and Sub status: QQSSSS
export const PlcTagQC = {
  // Bit masks for Quality, Status and Limits
  TAG_QUALITY_MASK: 0xc0,
  TAG_STATUS_MASK: 0xfc,
  TAG_LIMIT_MASK: 0x03,

  // Values for Quality
  TAG_QUALITY_BAD: 0x00,
  TAG_QUALITY_UNCERTAIN: 0x40,
  TAG_QUALITY_GOOD: 0xc0,

  // Status bits when Quality = BAD
  TAG_QUALITY_CONFIG_ERROR: 0x04,
  TAG_QUALITY_NOT_CONNECTED: 0x08,
  TAG_QUALITY_DEVICE_FAILURE: 0x0c,
  TAG_QUALITY_SENSOR_FAILURE: 0x10,
  TAG_QUALITY_LAST_KNOWN: 0x14,
  TAG_QUALITY_COMM_FAILURE: 0x18,
  TAG_QUALITY_OUT_OF_SERVICE: 0x1c,
  TAG_QUALITY_WAITING_FOR_INITIAL_DATA: 0x20,

  // Status bits when Quality = UNCERTAIN
  TAG_QUALITY_LAST_USABLE: 0x44,
  TAG_QUALITY_SENSOR_CAL: 0x50,
  TAG_QUALITY_EGU_EXCEEDED: 0x54,
  TAG_QUALITY_SUB_NORMAL: 0x58,

  // Status bits when Quality = GOOD
  TAG_QUALITY_LOCAL_OVERRIDE: 0xd8,

  // Status bits for Limit Bitfield
  TAG_LIMIT_OK: 0x00,
  TAG_LIMIT_LOW: 0x01,
  TAG_LIMIT_HIGH: 0x02,
  TAG_LIMIT_CONST: 0x03,
} as const;
