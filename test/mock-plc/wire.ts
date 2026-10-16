/*
 * Wire level helpers of the mock PLC: TPKT/COTP framing and S7CommPlus fragment (de)assembly.
 * Byte layouts follow Net/S7Client.cs (ISO-on-TCP) and S7CommPlusConnection.cs (SendS7plusPDUdata / OnDataReceived).
 */

export const COTP_CR = 0xe0;
export const COTP_CC = 0xd0;
export const COTP_DT = 0xf0;

export interface TpktFrame {
  /** Complete frame including the 4 byte TPKT header. */
  raw: Uint8Array;
  /** COTP PDU type (0xE0 CR, 0xD0 CC, 0xF0 DT, ...). */
  cotpType: number;
  /** COTP user data (for DT: the payload behind the 3 byte COTP header). */
  payload: Uint8Array;
  /** EOT flag of a DT TPDU. */
  eot: boolean;
}

/** Splits a TCP byte stream into TPKT frames (arbitrary segmentation). */
export class TpktParser {
  private buf: Buffer = Buffer.alloc(0);

  push(data: Uint8Array): TpktFrame[] {
    this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
    const out: TpktFrame[] = [];
    while (this.buf.length >= 4) {
      if (this.buf[0] !== 3) throw new Error("mock PLC: bad TPKT version " + this.buf[0]);
      const len = this.buf.readUInt16BE(2);
      if (len < 7) throw new Error("mock PLC: bad TPKT length " + len);
      if (this.buf.length < len) break;
      const raw = new Uint8Array(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
      const li = raw[4];
      const cotpType = raw[5];
      out.push({
        raw,
        cotpType,
        payload: raw.subarray(5 + li),
        eot: cotpType === COTP_DT ? (raw[6] & 0x80) !== 0 : true,
      });
    }
    return out;
  }
}

/** Builds a DT TPKT frame. */
export function dtFrame(payload: Uint8Array, eot = true): Uint8Array {
  const out = new Uint8Array(7 + payload.length);
  out[0] = 3;
  out[1] = 0;
  out[2] = (out.length >> 8) & 0xff;
  out[3] = out.length & 0xff;
  out[4] = 2;
  out[5] = COTP_DT;
  out[6] = eot ? 0x80 : 0x00;
  out.set(payload, 7);
  return out;
}

/** Builds the 36 byte connection confirm the C# client insists on (S7Client.ISOConnect: Size == 36, type 0xD0). */
export function ccFrame(srcRef: [number, number], dstTsap: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + 16);
  out.set([
    0x03, 0x00, 0x00, 0x24, // TPKT, length 36
    0x1f, COTP_CC, srcRef[0], srcRef[1], 0x00, 0x01, 0x00, // LI=31, CC, dst ref (= CR src ref), src ref 1, class 0
    0xc0, 0x01, 0x0a, // TPDU size
    0xc1, 0x02, 0x06, 0x00, // calling TSAP
    0xc2, 0x10, // called TSAP, 16 bytes
  ]);
  out.set(dstTsap.subarray(0, 16), 20);
  return out;
}

export interface CrInfo {
  srcRef: [number, number];
  localTsap: number;
  remoteTsap: string;
  /** TPDU size parameter (0xC0) if present */
  tpduSizeCode: number | null;
}

export function parseCr(frame: TpktFrame): CrInfo {
  const r = frame.raw;
  if (frame.cotpType !== COTP_CR) throw new Error("not a CR");
  const info: CrInfo = { srcRef: [r[8], r[9]], localTsap: 0, remoteTsap: "", tpduSizeCode: null };
  let p = 11; // after class/options
  while (p + 2 <= r.length) {
    const code = r[p];
    const len = r[p + 1];
    const val = r.subarray(p + 2, p + 2 + len);
    if (code === 0xc1) info.localTsap = (val[0] << 8) | val[1];
    else if (code === 0xc2) info.remoteTsap = Buffer.from(val).toString("latin1");
    else if (code === 0xc0) info.tpduSizeCode = val[0];
    p += 2 + len;
  }
  return info;
}

export interface S7pPdu {
  /** protocol version of the fragment headers */
  version: number;
  /** concatenated data parts (without S7+ headers/trailer), the first byte is NOT the version */
  data: Uint8Array;
  /** number of fragments the PDU consisted of */
  fragments: number;
}

/**
 * Reassembles S7CommPlus PDUs from a byte stream: header(4) = 0x72, version, len(2); data; the last fragment is
 * followed by a trailer 0x72, version, 0x00, 0x00. A fragment without trailer is followed by another header.
 */
export class S7pAssembler {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private version = 0;

  push(data: Uint8Array): S7pPdu[] {
    this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
    const out: S7pPdu[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      if (this.buf[0] !== 0x72) throw new Error("mock PLC: bad S7+ header byte 0x" + this.buf[0].toString(16));
      const ver = this.buf[1];
      const len = this.buf.readUInt16BE(2);
      if (this.buf.length < 4 + len + 4) break; // need the data and the next 4 bytes (trailer or next header)
      const next = this.buf.subarray(4 + len, 4 + len + 4);
      const isTrailer = next[0] === 0x72 && next[1] === ver && next[2] === 0 && next[3] === 0;
      this.version = ver;
      this.parts.push(Buffer.from(this.buf.subarray(4, 4 + len)));
      if (isTrailer) {
        this.buf = this.buf.subarray(4 + len + 4);
        out.push({ version: this.version, data: new Uint8Array(Buffer.concat(this.parts)), fragments: this.parts.length });
        this.parts = [];
      } else {
        this.buf = this.buf.subarray(4 + len);
      }
    }
    return out;
  }
}

/** Fragments a PDU body into S7+ fragments (trailer in the last one). */
export function s7pFragments(version: number, body: Uint8Array, maxData: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  do {
    const n = Math.min(maxData, body.length - pos);
    const last = pos + n >= body.length;
    const f = new Uint8Array(4 + n + (last ? 4 : 0));
    f[0] = 0x72;
    f[1] = version;
    f[2] = n >> 8;
    f[3] = n & 0xff;
    f.set(body.subarray(pos, pos + n), 4);
    if (last) f.set([0x72, version, 0, 0], 4 + n);
    out.push(f);
    pos += n;
  } while (pos < body.length);
  return out;
}

/** A SystemEvent style PDU (protocol 0xFE): header only, no trailer. */
export function s7pSystemEventFrame(data: Uint8Array): Uint8Array {
  const f = new Uint8Array(4 + data.length);
  f[0] = 0x72;
  f[1] = 0xfe;
  f[2] = data.length >> 8;
  f[3] = data.length & 0xff;
  f.set(data, 4);
  return f;
}
