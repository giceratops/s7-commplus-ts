import { describe, it, expect } from "vitest";
import { ByteStream, S7p, PValue, ValueDInt, ValueLInt, ValueWString, ValueUDIntArray, ExploreRequest } from "../src/index.js";

const rt = (v: PValue): PValue => {
  const b = new ByteStream();
  v.serialize(b);
  b.position = 0;
  return PValue.deserialize(b)!;
};

describe("S7p VLQ", () => {
  it("round-trips uint32/int32/uint64/int64", () => {
    for (const n of [0, 1, 0x7f, 0x80, 0xff, 0x3fff, 0x12345678, 0xffffffff]) {
      const b = new ByteStream(); S7p.encodeUInt32Vlq(b, n); b.position = 0;
      expect(S7p.decodeUInt32Vlq(b)).toBe(n);
    }
    for (const n of [0, -1, 63, -64, 64, -65, 2147483647, -2147483648]) {
      const b = new ByteStream(); S7p.encodeInt32Vlq(b, n); b.position = 0;
      expect(S7p.decodeInt32Vlq(b)).toBe(n);
    }
    for (const n of [0n, 0xffn, 0x7fn, 0xffffffffffn, 0xffffffffffffffffn]) {
      const b = new ByteStream(); S7p.encodeUInt64Vlq(b, n); b.position = 0;
      expect(S7p.decodeUInt64Vlq(b)).toBe(n);
    }
    for (const n of [0n, -1n, 9223372036854775807n, -9223372036854775808n]) {
      const b = new ByteStream(); S7p.encodeInt64Vlq(b, n); b.position = 0;
      expect(S7p.decodeInt64Vlq(b)).toBe(n);
    }
  });
});

describe("PValue", () => {
  it("round-trips scalars and arrays", () => {
    expect((rt(new ValueDInt(-42)) as ValueDInt).getValue()).toBe(-42);
    expect((rt(new ValueLInt(-5n)) as ValueLInt).getValue()).toBe(-5n);
    expect((rt(new ValueWString("héllo")) as ValueWString).getValue()).toBe("héllo");
    expect((rt(new ValueUDIntArray([1, 2, 3])) as ValueUDIntArray).getValue()).toEqual([1, 2, 3]);
  });
});

describe("requests", () => {
  it("serializes ExploreRequest", () => {
    const r = new ExploreRequest(0x03);
    r.sessionId = 5; r.sequenceNumber = 7; r.integrityId = 1;
    const b = new ByteStream();
    expect(r.serialize(b)).toBe(b.length);
    expect(b.toArray()[0]).toBe(0x31);
  });
});
