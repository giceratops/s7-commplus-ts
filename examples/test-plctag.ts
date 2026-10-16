/*
 * Port of DriverTest/TestPlcTag.cs (S7CommPlusDriver, Thomas Wiens, LGPL v3+). Ported to TypeScript.
 * PLC hardware test suite for every PlcTag type; it runs against the PLC programs in the plc/ folder.
 * Usage: npx tsx examples/test-plctag.ts <ip> [password]
 */
import { pathToFileURL } from "node:url";
import {
  ItemAddress,
  PlcTagAny,
  PlcTagBool,
  PlcTagByte,
  PlcTagChar,
  PlcTagDInt,
  PlcTagDTL,
  PlcTagDate,
  PlcTagDateAndTime,
  PlcTagDWord,
  PlcTagInt,
  PlcTagLDT,
  PlcTagLInt,
  PlcTagLReal,
  PlcTagLTOD,
  PlcTagLTime,
  PlcTagLWord,
  PlcTagPointer,
  PlcTagReal,
  PlcTagS5Time,
  PlcTagSInt,
  PlcTagString,
  PlcTagTime,
  PlcTagTimeOfDay,
  PlcTagUDInt,
  PlcTagUInt,
  PlcTagULInt,
  PlcTagUSInt,
  PlcTagWChar,
  PlcTagWord,
  PlcTagWString,
  S7CommPlusConnection,
  Softdatatype,
} from "../src/index.js";
import type { PlcTag } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers replacing System.Random / RandomExt / String.Format
// ---------------------------------------------------------------------------

/** Random.Next(min, max): min inclusive, max exclusive */
function nextInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

/** RandomExt.NextLong(min, max): random bigint in [min, max) (non-cryptographic) */
function nextLong(min: bigint, max: bigint): bigint {
  const range = max - min;
  const bytes = new Uint8Array(8);
  let urnd: bigint;
  const maxU = 0xffffffffffffffffn;
  do {
    for (let i = 0; i < 8; i++) bytes[i] = nextInt(0, 256);
    urnd = new DataView(bytes.buffer).getBigUint64(0, true);
  } while (urnd > maxU - ((maxU % range) + 1n) % range);
  return (urnd % range) + min;
}

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const UINT_MAX = 4294967295;
const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;
const ULONG_MAX = 18446744073709551615n;
const FLOAT_MAX = 3.4028234663852886e38;

const padL = (s: string | number | bigint, w: number): string => String(s).padEnd(w);
const hex = (v: number | bigint, w: number): string => v.toString(16).toUpperCase().padStart(w, "0");
const beep = (): void => {
  process.stdout.write("\x07");
};
const dateShort = (d: Date): string =>
  String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0") + "/" + String(d.getFullYear()).padStart(4, "0");
const dateLong = (d: Date): string =>
  dateShort(d) + " " + [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

function getHexstring(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += hex(b[i], 2) + " ";
  return s;
}

function seqEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function randomMaxString(maxlength: number): string {
  let smax = "";
  let cval = 32; // Space
  for (let i = 0; i < maxlength; i++) {
    smax += String.fromCharCode(cval);
    cval++;
    if (cval > 126) cval = 32;
  }
  return smax;
}

// ---------------------------------------------------------------------------

interface Spec<T> {
  tag: PlcTag;
  values: T[];
  /** Assign the write value to the tag */
  set: (v: T) => void;
  /** true if the tag (after read) equals the written value */
  eq: (v: T) => boolean;
  /** Text of the tag's current value (read) */
  fmtRead: () => string;
  /** Text of the written value */
  fmtWrite: (v: T) => string;
}

export class TestPlcTag {
  // If the DB is created from source, the .x IDs should
  // be remain the same, if there's no change in the DB at the variables after compiling.
  // 8A0E000F is in this case 0x05 = DB15.
  // The pointer variable types can only be located in an instance DB of a FB.
  PlcTagBoolAddress = "8A0E000F.9";
  PlcTagByteAddress = "8A0E000F.A";
  PlcTagWordAddress = "8A0E000F.B";
  PlcTagDWordAddress = "8A0E000F.C";
  PlcTagLWordAddress = "8A0E000F.D";
  PlcTagUSIntAddress = "8A0E000F.E";
  PlcTagSIntAddress = "8A0E000F.F";
  PlcTagUIntAddress = "8A0E000F.10";
  PlcTagIntAddress = "8A0E000F.11";
  PlcTagUDIntAddress = "8A0E000F.12";
  PlcTagDIntAddress = "8A0E000F.13";
  PlcTagULIntAddress = "8A0E000F.14";
  PlcTagLIntAddress = "8A0E000F.15";
  PlcTagRealAddress = "8A0E000F.16";
  PlcTagLRealAddress = "8A0E000F.17";
  PlcTagTimeAddress = "8A0E000F.18";
  PlcTagLTimeAddress = "8A0E000F.19";
  PlcTagS5TimeAddress = "8A0E000F.1A";
  PlcTagDateAddress = "8A0E000F.1B";
  PlcTagDateAndTimeAddress = "8A0E000F.1C";
  PlcTagDTLAddress = "8A0E000F.1D";
  PlcTagLDTAddress = "8A0E000F.1E";
  PlcTagTimeOfDayAddress = "8A0E000F.1F";
  PlcTagLTODAddress = "8A0E000F.20";
  PlcTagCharAddress = "8A0E000F.21";
  PlcTagWCharAddress = "8A0E000F.22";
  PlcTagStringAddress = "8A0E000F.23";
  PlcTagWStringAddress = "8A0E000F.24";
  // Pointer types are located in a different instance DB
  PlcTagPointerAddress = "8A0E0001.A";
  PlcTagAnyAddress = "8A0E0001.9";

  /**
   * Start the testrun for the PlcTag types
   * @param conn Connection to use for the test
   * @param nrandom Number of random values to generate for each Tag type
   * @param testPointers Option to do the testruns on Pointer types (Any, Pointer)
   * @returns number of errors
   */
  async doTests(conn: S7CommPlusConnection, nrandom: number, testPointers: boolean): Promise<number> {
    let result = 0;

    // Boolean
    result += await this.testBool(conn);
    // Bitstrings
    result += await this.testByte(conn, nrandom);
    result += await this.testWord(conn, nrandom);
    result += await this.testDWord(conn, nrandom);
    result += await this.testLWord(conn, nrandom);
    // Integers
    result += await this.testUSInt(conn, nrandom);
    result += await this.testSInt(conn, nrandom);
    result += await this.testUInt(conn, nrandom);
    result += await this.testInt(conn, nrandom);
    result += await this.testUDInt(conn, nrandom);
    result += await this.testDInt(conn, nrandom);
    result += await this.testULInt(conn, nrandom);
    result += await this.testLInt(conn, nrandom);
    // Floating point
    result += await this.testReal(conn, nrandom);
    result += await this.testLReal(conn, nrandom);
    // Time values
    result += await this.testTime(conn, nrandom);
    result += await this.testLTime(conn, nrandom);
    result += await this.testS5Time(conn, nrandom);
    // Date and Time values
    result += await this.testDate(conn, nrandom);
    result += await this.testDateAndTime(conn, nrandom);
    result += await this.testLDT(conn, nrandom);
    result += await this.testTimeOfDay(conn, nrandom);
    result += await this.testLTOD(conn, nrandom);
    result += await this.testDTL(conn, nrandom);
    // Strings
    result += await this.testChar(conn, nrandom);
    result += await this.testWChar(conn, nrandom);
    result += await this.testString(conn, nrandom);
    result += await this.testWString(conn, nrandom);
    // Pointers
    if (testPointers) {
      // only optional, because depending on the testprogram, you can't write them
      result += await this.testPointer(conn, nrandom);
      result += await this.testAny(conn, nrandom);
    }

    console.log();
    console.log("=======================================");
    console.log("DoTests: Number of errors = " + result);
    console.log("=======================================");
    return result;
  }

  /** The common read / write / read-back / compare loop of all the C# Test_PlcTag_* methods. */
  private async run<T>(conn: S7CommPlusConnection, title: string, s: Spec<T>): Promise<number> {
    let result = 0;
    console.log("*** " + title + " ***");
    const tags: PlcTag[] = [s.tag];
    const n = padL(s.tag.name, 20);
    await conn.readTags(tags);
    console.log(`Name= ${n}: Read value  = ${s.fmtRead()}`);
    for (const writevalue of s.values) {
      s.set(writevalue);
      console.log(`Name= ${n}: Write value = ${s.fmtWrite(writevalue)}`);
      await conn.writeTags(tags);
      await conn.readTags(tags);
      console.log(`Name= ${n}: Read value  = ${s.fmtRead()}`);
      if (s.eq(writevalue)) {
        console.log(`Name= ${n}: Success.`);
      } else {
        beep();
        console.log(`Name= ${n}: FAILED!!!`);
        result++;
      }
    }
    return result;
  }

  /** Spec for tags with a plain `value` field compared with ===. */
  private simple<T extends number | bigint | string>(
    tag: PlcTag & { value: T },
    values: T[],
    fmt: (v: T) => string = (v) => String(v),
  ): Spec<T> {
    return {
      tag,
      values,
      set: (v) => {
        tag.value = v;
      },
      eq: (v) => tag.value === v,
      fmtRead: () => fmt(tag.value),
      fmtWrite: fmt,
    };
  }

  // #region Tests for Boolean tags
  private async testBool(conn: S7CommPlusConnection): Promise<number> {
    let result = 0;
    console.log("*** TestPlcTag_Bool ***");
    const tags: PlcTag[] = [];
    const tag = new PlcTagBool("Bool_Var", new ItemAddress(this.PlcTagBoolAddress), Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL);
    const n = padL(tag.name, 20);
    tags.push(tag);
    for (let i = 0; i < 5; i++) {
      await conn.readTags(tags);
      console.log(`Name= ${n}: Read value  = ${tag.value ? "True" : "False"}`);
      const writevalue = !tag.value;
      tag.value = writevalue;
      console.log(`Name= ${n}: Write value = ${writevalue ? "True" : "False"}`);
      await conn.writeTags(tags);
      await conn.readTags(tags);
      console.log(`Name= ${n}: Read value  = ${tag.value ? "True" : "False"}`);
      if (tag.value === writevalue) {
        console.log(`Name= ${n}: Success.`);
      } else {
        beep();
        console.log(`Name= ${n}: FAILED!!!`);
        result++;
      }
    }
    return result;
  }
  // #endregion

  // #region Tests for Bitstring tags
  private testByte(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagByte("Byte_Var", new ItemAddress(this.PlcTagByteAddress), Softdatatype.S7COMMP_SOFTDATATYPE_BYTE);
    const v = [0x00, 0x01, 0x55, 0xaa, 0xff];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(0, 255));
    return this.run(conn, "Test_PlcTag_Byte", this.simple(tag, v, (x) => "0x" + hex(x, 2)));
  }

  private testWord(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagWord("Word_Var", new ItemAddress(this.PlcTagWordAddress), Softdatatype.S7COMMP_SOFTDATATYPE_WORD);
    const v = [0x0000, 0x0001, 0xa5a5, 0x5a5a, 0xffff];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(0, 65535));
    return this.run(conn, "Test_PlcTag_Word", this.simple(tag, v, (x) => "0x" + hex(x, 4)));
  }

  private testDWord(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagDWord("DWord_Var", new ItemAddress(this.PlcTagDWordAddress), Softdatatype.S7COMMP_SOFTDATATYPE_DWORD);
    const v = [0x00000000, 0x00000001, 0xa5a5a5a5, 0x5a5a5a5a, 0xffffffff];
    for (let i = 0; i < nrandom; i++) v.push(Number(nextLong(0n, BigInt(UINT_MAX))));
    return this.run(conn, "Test_PlcTag_DWord", this.simple(tag, v, (x) => "0x" + hex(x, 8)));
  }

  private testLWord(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLWord("LWord_Var", new ItemAddress(this.PlcTagLWordAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LWORD);
    const v = [0x0000000000000000n, 0x0000000000000001n, 0xa5a5a5a5a5a5a5a5n, 0x5a5a5a5a5a5a5a5an, 0xffffffffffffffffn];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(0n, LONG_MAX) + nextLong(0n, LONG_MAX));
    return this.run(conn, "Test_PlcTag_LWord", this.simple(tag, v, (x) => "0x" + hex(x, 8)));
  }
  // #endregion

  // #region Tests for Integer tags
  private testUSInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagUSInt("USInt_Var", new ItemAddress(this.PlcTagUSIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_USINT);
    const v = [0, 1, 123, 210, 255];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(0, 255));
    return this.run(conn, "Test_PlcTag_USInt", this.simple(tag, v));
  }

  private testSInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagSInt("SInt_Var", new ItemAddress(this.PlcTagSIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_SINT);
    const v = [-128, 0, 1, 123, 127];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(-128, 127));
    return this.run(conn, "Test_PlcTag_SInt", this.simple(tag, v));
  }

  private testUInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagUInt("UInt_Var", new ItemAddress(this.PlcTagUIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_UINT);
    const v = [0, 1, 12345, 4321, 65535];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(0, 65535));
    return this.run(conn, "Test_PlcTag_UInt", this.simple(tag, v));
  }

  private testInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagInt("Int_Var", new ItemAddress(this.PlcTagIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_INT);
    const v = [-32768, -12345, 0, 12345, 32767];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(-32768, 32767));
    return this.run(conn, "Test_PlcTag_Int", this.simple(tag, v));
  }

  private testUDInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagUDInt("UDInt_Var", new ItemAddress(this.PlcTagUDIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_UDINT);
    const v = [0, 1, 127, 128, 255, 256, 1234567, UINT_MAX];
    for (let i = 0; i < nrandom; i++) v.push(Number(nextLong(0n, BigInt(UINT_MAX))));
    return this.run(conn, "Test_PlcTag_UDInt", this.simple(tag, v));
  }

  private testDInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagDInt("DInt_Var", new ItemAddress(this.PlcTagDIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_DINT);
    const v = [INT_MIN, -256, -255, -128, -127, 0, 127, 128, 255, 256, INT_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(INT_MIN, INT_MAX));
    return this.run(conn, "Test_PlcTag_DInt", this.simple(tag, v));
  }

  private testULInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagULInt("ULInt_Var", new ItemAddress(this.PlcTagULIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_ULINT);
    const v = [0n, 127n, 128n, 255n, 256n, 0x00ffffffffffffffn, 0x00ffffffffffffffn + 1n, 0x00ffffffffffffffn + 2n, ULONG_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(0n, LONG_MAX) + nextLong(0n, LONG_MAX));
    return this.run(conn, "Test_PlcTag_ULInt", this.simple(tag, v));
  }

  private testLInt(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLInt("LInt_Var", new ItemAddress(this.PlcTagLIntAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LINT);
    const v = [LONG_MIN, -256n, -255n, -128n, -127n, 0n, 127n, 128n, 255n, 256n, 0x007fffffffffffffn, 0x007fffffffffffffn + 1n, LONG_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(LONG_MIN, LONG_MAX));
    return this.run(conn, "Test_PlcTag_LInt", this.simple(tag, v));
  }
  // #endregion

  // #region Tests for Floating point tags
  private testReal(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagReal("Real_Var", new ItemAddress(this.PlcTagRealAddress), Softdatatype.S7COMMP_SOFTDATATYPE_REAL);
    // float.NaN fails by design
    const v = [-FLOAT_MAX, -Infinity, Infinity, -1234.5, 0.0, 0.125, FLOAT_MAX];
    for (let i = 0; i < nrandom; i++) {
      const r = Math.random();
      const r1 = r * (FLOAT_MAX - -FLOAT_MAX) + -FLOAT_MAX;
      v.push(Math.fround(r1));
    }
    return this.run(conn, "Test_PlcTag_Real", this.simple(tag, v));
  }

  private testLReal(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLReal("LReal_Var", new ItemAddress(this.PlcTagLRealAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LREAL);
    // double.NaN fails by design
    const v = [-Number.MAX_VALUE, -Infinity, Infinity, -1234.5, 0.0, 0.125, Number.MAX_VALUE];
    for (let i = 0; i < nrandom; i++) {
      v.push(Math.random() * 2000.0 - 1000.0); // NextDouble gives values between 0..1, scale up that we get at least some negative values
    }
    return this.run(conn, "Test_PlcTag_LReal", this.simple(tag, v));
  }
  // #endregion

  // #region Tests for Time value tags
  private testTime(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagTime("Time_Var", new ItemAddress(this.PlcTagTimeAddress), Softdatatype.S7COMMP_SOFTDATATYPE_TIME);
    const v = [INT_MIN, -256, -255, -128, -127, 0, 127, 128, 255, 256, INT_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextInt(INT_MIN, INT_MAX));
    const s = this.simple(tag, v);
    s.fmtRead = () => `${padL(tag.value, 11)} - as String ${tag.toString()}`;
    s.fmtWrite = (x) => padL(x, 11);
    return this.run(conn, "Test_PlcTag_Time", s);
  }

  private testLTime(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLTime("LTime_Var", new ItemAddress(this.PlcTagLTimeAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LTIME);
    const v = [LONG_MIN, -256n, -255n, -128n, -127n, 0n, 127n, 128n, 255n, 256n, 0x007fffffffffffffn, 0x007fffffffffffffn + 1n, LONG_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(LONG_MIN, LONG_MAX));
    const s = this.simple(tag, v);
    s.fmtRead = () => `${padL(tag.value, 22)} - as String ${tag.toString()}`;
    s.fmtWrite = (x) => padL(x, 22);
    return this.run(conn, "Test_PlcTag_LTime", s);
  }

  private testS5Time(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagS5Time("S5Time_Var", new ItemAddress(this.PlcTagS5TimeAddress), Softdatatype.S7COMMP_SOFTDATATYPE_S5TIME);
    // TimeValue (0..999), TimeBase (0=10ms, 1=100ms, 2=1s, 3=10s)
    const v: Array<[number, number]> = [[0, 0], [1, 1], [999, 0], [10, 1], [123, 2], [999, 3]];
    for (let i = 0; i < nrandom; i++) v.push([nextInt(0, 999), nextInt(0, 3)]);
    return this.run<[number, number]>(conn, "Test_PlcTag_S5Time", {
      tag,
      values: v,
      set: ([tv, tb]) => {
        tag.timeValue = tv;
        tag.timeBase = tb;
      },
      eq: ([tv, tb]) => tag.timeValue === tv && tag.timeBase === tb,
      fmtRead: () => `(TimeValue, TimeBase) = (${padL(tag.timeValue, 3)}, ${padL(tag.timeBase, 3)}) -> ${padL(tag.toString(), 5)}`,
      fmtWrite: ([tv, tb]) => `(TimeValue, TimeBase) = (${padL(tv, 3)}, ${padL(tb, 3)})`,
    });
  }
  // #endregion

  // #region Tests for Date and Time value tags
  private testDate(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagDate("Date_Var", new ItemAddress(this.PlcTagDateAddress), Softdatatype.S7COMMP_SOFTDATATYPE_DATE);
    const v = [new Date(1990, 0, 1), new Date(2023, 11, 23), new Date(2169, 5, 6)];
    for (let i = 0; i < nrandom; i++) v.push(new Date(nextInt(1990, 2169), nextInt(1, 12) - 1, nextInt(1, 27)));
    return this.run(conn, "Test_PlcTag_Date", {
      tag,
      values: v,
      set: (x) => {
        tag.value = x;
      },
      eq: (x) => tag.value.getTime() === x.getTime(),
      fmtRead: () => dateShort(tag.value),
      fmtWrite: dateShort,
    });
  }

  private testDateAndTime(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagDateAndTime("DateAndTime_Var", new ItemAddress(this.PlcTagDateAndTimeAddress), Softdatatype.S7COMMP_SOFTDATATYPE_DATEANDTIME);
    const v = [new Date(1990, 0, 1), new Date(2023, 11, 23, 1, 2, 3, 123), new Date(2089, 11, 31, 23, 59, 59, 999)];
    for (let i = 0; i < nrandom; i++) {
      let dt = new Date(nextInt(1990, 2089), nextInt(1, 12) - 1, nextInt(1, 27));
      dt = new Date(dt.getTime() + nextInt(0, 864000) * 1000);
      dt = new Date(dt.getTime() + nextInt(0, 999));
      v.push(dt);
    }
    const f = (d: Date): string => `${dateLong(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    return this.run(conn, "Test_PlcTag_DateAndTime", {
      tag,
      values: v,
      set: (x) => {
        tag.value = x;
      },
      eq: (x) => tag.value.getTime() === x.getTime(),
      fmtRead: () => f(tag.value),
      fmtWrite: f,
    });
  }

  private testLDT(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLDT("LDT_Var", new ItemAddress(this.PlcTagLDTAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LDT);
    const v = [0n, 127n, 128n, 255n, 256n, 0x00ffffffffffffffn, 0x00ffffffffffffffn + 1n, 0x00ffffffffffffffn + 2n, ULONG_MAX];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(0n, LONG_MAX) + nextLong(0n, LONG_MAX));
    const s = this.simple(tag, v);
    s.fmtRead = () => `${padL(tag.value, 20)} - as String ${tag.toString()}`;
    s.fmtWrite = (x) => padL(x, 20);
    return this.run(conn, "Test_PlcTag_LDT", s);
  }

  private testTimeOfDay(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagTimeOfDay("TimeOfDay_Var", new ItemAddress(this.PlcTagTimeOfDayAddress), Softdatatype.S7COMMP_SOFTDATATYPE_TIMEOFDAY);
    const v = [0, 1, 123456, 86400000 - 1];
    for (let i = 0; i < nrandom; i++) v.push(Number(nextLong(0n, 86400000n - 1n)));
    const s = this.simple(tag, v);
    s.fmtRead = () => `${padL(tag.value, 20)} - as String ${tag.toString()}`;
    s.fmtWrite = (x) => padL(x, 20);
    return this.run(conn, "Test_PlcTag_TimeOfDay", s);
  }

  private testLTOD(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagLTOD("LTOD_Var", new ItemAddress(this.PlcTagLTODAddress), Softdatatype.S7COMMP_SOFTDATATYPE_LTOD);
    const v = [0n, 1234n, 1234567890n, 86400000000000n - 1n];
    for (let i = 0; i < nrandom; i++) v.push(nextLong(0n, 86400000000000n - 1n));
    const s = this.simple(tag, v);
    s.fmtRead = () => `${padL(tag.value, 20)} - as String ${tag.toString()}`;
    s.fmtWrite = (x) => padL(x, 20);
    return this.run(conn, "Test_PlcTag_LTOD", s);
  }

  private testDTL(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagDTL("DTL_Var", new ItemAddress(this.PlcTagDTLAddress), Softdatatype.S7COMMP_SOFTDATATYPE_DTL);
    // We can't use the milliseconds in Date here, because all is done with an additional Nanosecond field.
    const v: Array<[Date, number]> = [];
    v.push([new Date(1970, 0, 1), 0]);
    v.push([new Date(2023, 11, 23, 1, 2, 3, 0), 123456789]);
    v.push([new Date(2089, 11, 31, 23, 59, 59, 0), 999999999]);
    v.push([new Date(2262, 3, 11, 23, 47, 16, 0), 854775807]);
    for (let i = 0; i < nrandom; i++) {
      let dt = new Date(nextInt(1970, 2261), nextInt(1, 12) - 1, nextInt(1, 27));
      dt = new Date(dt.getTime() + nextInt(0, 864000) * 1000);
      v.push([dt, nextInt(0, 999999999)]);
    }
    // interface timestamp, important!
    console.log("DTLInterfaceTimestamp=" + tag.dtlInterfaceTimestamp);
    const f = (d: Date, ns: number): string => `${dateLong(d)}.${String(ns).padStart(9, "0")}`;
    return this.run<[Date, number]>(conn, "Test_PlcTag_DTL", {
      tag,
      values: v,
      set: ([dt, ns]) => {
        tag.value = dt;
        tag.valueNanosecond = ns;
      },
      eq: ([dt, ns]) => tag.value.getTime() === dt.getTime() && tag.valueNanosecond === ns,
      fmtRead: () => f(tag.value, tag.valueNanosecond),
      fmtWrite: ([dt, ns]) => f(dt, ns),
    });
  }
  // #endregion

  // #region Tests for Character / String tags
  private testChar(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagChar("Char_Var", new ItemAddress(this.PlcTagCharAddress), Softdatatype.S7COMMP_SOFTDATATYPE_CHAR);
    const v = ["A", "B", " ", "ä", "1"];
    for (let i = 0; i < nrandom; i++) v.push(String.fromCharCode(nextInt(32, 126)));
    return this.run(conn, "Test_PlcTag_Char", this.simple(tag, v));
  }

  private testWChar(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagWChar("WChar_Var", new ItemAddress(this.PlcTagWCharAddress), Softdatatype.S7COMMP_SOFTDATATYPE_WCHAR);
    const v = ["A", "B", " ", "ä", "1", "Ʃ"];
    for (let i = 0; i < nrandom; i++) v.push(String.fromCharCode(nextInt(32, 126))); // TODO: Write some Unicode values?
    return this.run(conn, "Test_PlcTag_WChar", this.simple(tag, v));
  }

  private testString(conn: S7CommPlusConnection, _nrandom: number): Promise<number> {
    const stringMaxlength = 254;
    const tag = new PlcTagString("String_Var", new ItemAddress(this.PlcTagStringAddress), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, stringMaxlength);
    const v = ["Hello", "World", "This is a test!", "Motörhead", "abcdefghijklmnopqrstuvwxyz1234567890"];
    // Generate a string of maxlength
    v.push(randomMaxString(stringMaxlength));
    return this.run(conn, "Test_PlcTag_String", this.simple(tag, v));
  }

  private testWString(conn: S7CommPlusConnection, _nrandom: number): Promise<number> {
    const stringMaxlength = 254;
    const tag = new PlcTagWString("WString_Var", new ItemAddress(this.PlcTagWStringAddress), Softdatatype.S7COMMP_SOFTDATATYPE_WSTRING, stringMaxlength);
    const v = ["Hello", "World", "This is a test!", "Motörhead", "Test Greek ΣΛΔ end."];
    // Generate a string of maxlength
    v.push(randomMaxString(stringMaxlength));
    return this.run(conn, "Test_PlcTag_WString", this.simple(tag, v));
  }
  // #endregion

  // #region Tests for Pointers type tags
  private testPointer(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagPointer("Pointer_Var", new ItemAddress(this.PlcTagPointerAddress), Softdatatype.S7COMMP_SOFTDATATYPE_POINTER);
    const v: Uint8Array[] = [];
    v.push(new Uint8Array([0x04, 0xd2, 0x84, 0x06, 0xee, 0xaa])); // P#DB1234.DBX56789.2
    v.push(new Uint8Array([0xff, 0xff, 0x84, 0x01, 0x81, 0xcc])); // P#DB65535.DBX12345.4
    for (let i = 0; i < nrandom; i++) {
      const b = new Uint8Array(6);
      const dbnr = nextInt(1, 65535);
      b[0] = dbnr >> 8;
      b[1] = dbnr & 0xff;
      b[2] = 0x84; // only in DBX area full range of dbnr and bytenr is allowed
      const bytenr = nextInt(0, 65535);
      const bitnr = nextInt(0, 7);
      b[3] = (bytenr >> 13) & 0xff;
      b[4] = (bytenr >> 5) & 0xff;
      b[5] = (bitnr | (bytenr << 3)) & 0xff;
      v.push(b);
    }
    return this.run(conn, "Test_PlcTag_Pointer", {
      tag,
      values: v,
      set: (x) => {
        tag.value = x;
      },
      eq: (x) => seqEqual(tag.value, x),
      fmtRead: () => `${getHexstring(tag.value)} ${tag.toString()}`,
      fmtWrite: getHexstring,
    });
  }

  private testAny(conn: S7CommPlusConnection, nrandom: number): Promise<number> {
    const tag = new PlcTagAny("Any_Var", new ItemAddress(this.PlcTagAnyAddress), Softdatatype.S7COMMP_SOFTDATATYPE_ANY);
    const v: Uint8Array[] = [];
    v.push(new Uint8Array([0x10, 0x02, 0x00, 0x7b, 0x04, 0xd2, 0x84, 0x06, 0xee, 0xaa])); // P#DB1234.DBX56789.2 BYTE 123
    v.push(new Uint8Array([0x10, 0x02, 0x02, 0xa6, 0xff, 0xff, 0x84, 0x01, 0x81, 0xcc])); // P#DB65535.DBX12345.4 BYTE 678
    for (let i = 0; i < nrandom; i++) {
      const b = new Uint8Array(10);
      b[0] = 0x10; // header
      b[1] = 0x02; // datatype 2=byte
      const factor = nextInt(1, 65535);
      b[2] = factor >> 8;
      b[3] = factor & 0xff;
      const dbnr = nextInt(1, 65535);
      b[4] = dbnr >> 8;
      b[5] = dbnr & 0xff;
      b[6] = 0x84; // only in DBX area full range of dbnr and bytenr is allowed
      const bytenr = nextInt(0, 65535);
      const bitnr = nextInt(0, 7);
      b[7] = (bytenr >> 13) & 0xff;
      b[8] = (bytenr >> 5) & 0xff;
      b[9] = (bitnr | (bytenr << 3)) & 0xff;
      v.push(b);
    }
    return this.run(conn, "Test_PlcTag_Any", {
      tag,
      values: v,
      set: (x) => {
        tag.value = x;
      },
      eq: (x) => seqEqual(tag.value, x),
      fmtRead: () => `${getHexstring(tag.value)} ${tag.toString()}`,
      fmtWrite: getHexstring,
    });
  }
  // #endregion
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npx tsx examples/test-plctag.ts <ip> [password]");
    process.exit(1);
  }
  const conn = new S7CommPlusConnection();
  const res = await conn.connect(args[0], args[1] ?? "");
  if (res !== 0) {
    console.log("Connect failed! res=" + res);
    process.exit(1);
  }
  const errors = await new TestPlcTag().doTests(conn, 10, false);
  await conn.disconnect();
  process.exit(errors === 0 ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
