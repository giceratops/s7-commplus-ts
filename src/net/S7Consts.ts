/*
 * S7CommPlusDriver - Based on Snap7 (Sharp7.cs) by Davide Nardella, licensed under LGPL.
 * Ported to TypeScript.
 */

export const S7Consts = {
  errTCPSocketCreation: 0x00000001,
  errTCPConnectionTimeout: 0x00000002,
  errTCPConnectionFailed: 0x00000003,
  errTCPReceiveTimeout: 0x00000004,
  errTCPDataReceive: 0x00000005,
  errTCPSendTimeout: 0x00000006,
  errTCPDataSend: 0x00000007,
  errTCPConnectionReset: 0x00000008,
  errTCPNotConnected: 0x00000009,
  errTCPUnreachableHost: 0x00002751,
  errIsoConnect: 0x00010000, // Connection error
  errIsoInvalidPDU: 0x00030000, // Bad format
  errIsoInvalidDataSize: 0x00040000, // Bad Datasize passed to send/recv : buffer is invalid
  errCliNegotiatingPDU: 0x00100000,
  errCliInvalidParams: 0x00200000,
  errCliJobPending: 0x00300000,
  errCliTooManyItems: 0x00400000,
  errCliInvalidWordLen: 0x00500000,
  errCliPartialDataWritten: 0x00600000,
  errCliSizeOverPDU: 0x00700000,
  errCliInvalidPlcAnswer: 0x00800000,
  errCliAddressOutOfRange: 0x00900000,
  errCliInvalidTransportSize: 0x00A00000,
  errCliWriteDataSizeMismatch: 0x00B00000,
  errCliItemNotAvailable: 0x00C00000,
  errCliInvalidValue: 0x00D00000,
  errCliCannotStartPLC: 0x00E00000,
  errCliAlreadyRun: 0x00F00000,
  errCliCannotStopPLC: 0x01000000,
  errCliCannotCopyRamToRom: 0x01100000,
  errCliCannotCompress: 0x01200000,
  errCliAlreadyStop: 0x01300000,
  errCliFunNotAvailable: 0x01400000,
  errCliUploadSequenceFailed: 0x01500000,
  errCliInvalidDataSizeRecvd: 0x01600000,
  errCliInvalidBlockType: 0x01700000,
  errCliInvalidBlockNumber: 0x01800000,
  errCliInvalidBlockSize: 0x01900000,
  errCliNeedPassword: 0x01D00000,
  errCliInvalidPassword: 0x01E00000,
  errCliAccessDenied: 0x01E10000,
  errCliNoPasswordToSetOrClear: 0x01F00000,
  errCliJobTimeout: 0x02000000,
  errCliPartialDataRead: 0x02100000,
  errCliBufferTooSmall: 0x02200000,
  errCliFunctionRefused: 0x02300000,
  errCliDestroying: 0x02400000,
  errCliInvalidParamNumber: 0x02500000,
  errCliCannotChangeParam: 0x02600000,
  errCliFunctionNotImplemented: 0x02700000,
  errCliFirmwareNotSupported: 0x02800000,
  errCliDeviceNotSupported: 0x02900000,
  errOpenSSL: 0x03100000, //------------------------------------------------------------------------------
  p_u16_LocalPort: 1, // Not applicable here
  p_u16_RemotePort: 2,
  p_i32_PingTimeout: 3,
  p_i32_SendTimeout: 4,
  p_i32_RecvTimeout: 5,
  p_i32_WorkInterval: 6, // Not applicable here
  p_u16_SrcRef: 7, // Not applicable here
  p_u16_DstRef: 8, // Not applicable here
  p_u16_SrcTSap: 9, // Not applicable here
  p_i32_PDURequest: 10,
  p_i32_MaxClients: 11, // Not applicable here
  p_i32_BSendTimeout: 12, // Not applicable here
  p_i32_BRecvTimeout: 13, // Not applicable here
  p_u32_RecoveryTime: 14, // Not applicable here
  p_u32_KeepAliveTime: 15, // Not applicable here
} as const;
