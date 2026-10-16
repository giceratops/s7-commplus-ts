using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    static readonly byte[] BYTES = { 0, 1, 127, 128, 255, 0x55 };
    static readonly sbyte[] SBYTES = { 0, 1, -1, 127, -128 };

    static List<object[]> ScalarClasses()
    {
        // (class, edge values)
        return new List<object[]> {
            new object[]{ "ValueBool", new object[]{ true, false } },
            new object[]{ "ValueUSInt", BYTES.Cast<object>().ToArray() },
            new object[]{ "ValueByte", BYTES.Cast<object>().ToArray() },
            new object[]{ "ValueSInt", SBYTES.Cast<object>().ToArray() },
            new object[]{ "ValueUInt", U16.Cast<object>().ToArray() },
            new object[]{ "ValueWord", U16.Cast<object>().ToArray() },
            new object[]{ "ValueInt", I16.Cast<object>().ToArray() },
            new object[]{ "ValueUDInt", U32.Cast<object>().ToArray() },
            new object[]{ "ValueDWord", U32.Cast<object>().ToArray() },
            new object[]{ "ValueRID", U32.Cast<object>().ToArray() },
            new object[]{ "ValueAID", U32.Cast<object>().ToArray() },
            new object[]{ "ValueDInt", I32.Cast<object>().ToArray() },
            new object[]{ "ValueULInt", U64.Cast<object>().ToArray() },
            new object[]{ "ValueLWord", U64.Cast<object>().ToArray() },
            new object[]{ "ValueTimestamp", U64.Cast<object>().ToArray() },
            new object[]{ "ValueLInt", I64.Cast<object>().ToArray() },
            new object[]{ "ValueTimespan", I64.Cast<object>().ToArray() },
            new object[]{ "ValueReal", FL.Cast<object>().ToArray() },
            new object[]{ "ValueLReal", DB.Cast<object>().ToArray() },
            new object[]{ "ValueWString", STRS.Cast<object>().ToArray() },
        };
    }

    // Runs a build vector and then a decode vector (PValue.Deserialize) on the C# produced bytes
    static void PvVec(string id, JsonObject spec, bool alsoDecode = true)
    {
        var v = Program.Run("pvalue", id, spec, SER, STR);
        if (v.ContainsKey("buildErr")) return;
        var hex = (string)v["expect"][0]["hex"];
        if (hex == null) return;
        // plain decode, decode with trailing garbage, decode of truncated data
        Program.Run("pvalue-dec", id, Static("PValue"), Do("Deserialize", Stream(hex), false));
        if (hex.Length > 4) Program.Run("pvalue-dec", id + "-trunc", Static("PValue"), Do("Deserialize", Stream(hex.Substring(0, hex.Length - 2)), false));
        Program.Run("pvalue-dec", id + "-trail", Static("PValue"), Do("Deserialize", Stream(hex + "01020304"), false));
    }

    static void GenPValue()
    {
        PvVec("Null", New("ValueNull"));
        PvVec("Null-flags", New("ValueNull", A(5)));
        foreach (var sc in ScalarClasses())
        {
            string cls = (string)sc[0];
            var edges = (object[])sc[1];
            int i = 0;
            foreach (var e in edges)
            {
                PvVec(cls + "-" + i++, New(cls, A(e, 0)));
            }
            PvVec(cls + "-flags1", New(cls, A(edges[edges.Length > 1 ? 1 : 0], 1)));
            PvVec(cls + "-flags8", New(cls, A(edges[0], 8)));
            // arrays
            string acls = cls + "Array";
            foreach (var fl in new[] { 0x10, 0x20 })
            {
                PvVec(acls + "-empty-" + fl, New(acls, A(new object[0], fl)));
                PvVec(acls + "-one-" + fl, New(acls, A(new object[] { edges[edges.Length - 1] }, fl)));
                PvVec(acls + "-all-" + fl, New(acls, A(edges, fl)));
            }
            // bigger arrays: more than 127 / 16383 elements trigger multi byte VLQ counts
            var big = Enumerable.Range(0, 300).Select(k => edges[k % edges.Length]).ToArray();
            PvVec(acls + "-300", New(acls, A(big, 0x10)));
        }
        // blobs
        var blobs = new List<byte[]> { new byte[0], new byte[] { 1 }, new byte[] { 1, 2, 3, 4, 5, 255 }, Enumerable.Range(0, 200).Select(x => (byte)x).ToArray() };
        foreach (uint rid in new uint[] { 0, 1, 2, 5, 0x80000000, 0xffffffff })
            foreach (var b in blobs)
                PvVec("Blob-" + rid + "-" + b.Length, New("ValueBlob", A(rid, b, 0)));
        PvVec("Blob-null", New("ValueBlob", A(1, null, 0)));
        PvVec("BlobArray", New("ValueBlobArray", A(new[] { New("ValueBlob", A(1, blobs[1], 0)), New("ValueBlob", A(1, blobs[2], 0)) }, 0x20)));
        PvVec("BlobArray-empty", New("ValueBlobArray", A(new JsonArray(), 0x20)));
        PvVec("BlobArray-rid2", New("ValueBlobArray", A(new[] { New("ValueBlob", A(2, blobs[1], 0)), New("ValueBlob", A(2, blobs[2], 0)) }, 0x20)));
        // sparse arrays
        PvVec("UDIntSparse-empty", New("ValueUDIntSparseArray", A(Map(), 0x40)));
        PvVec("UDIntSparse", New("ValueUDIntSparseArray", A(Map((0u, 0u), (5u, 0xffffffffu), (1000000u, 0x80u), (0xffffffffu, 1u)), 0x40)));
        PvVec("DIntSparse-empty", New("ValueDIntSparseArray", A(Map(), 0x40)));
        PvVec("DIntSparse", New("ValueDIntSparseArray", A(Map((0u, -1), (5u, int.MinValue), (1000000u, int.MaxValue), (0xffffffffu, 64)), 0x40)));
        PvVec("WStringSparse-empty", New("ValueWStringSparseArray", A(Map(), 0x40)));
        PvVec("WStringSparse", New("ValueWStringSparseArray", A(Map((1u, "a"), (2u, ""), (3u, "héllo 日本"), (0xfffffffu, "\U0001F600")), 0x40)));
        PvVec("BlobSparse-empty", New("ValueBlobSparseArray", A(Map(), 0x40)));
        PvVec("BlobSparse", New("ValueBlobSparseArray", A(Map((1u, BlobEntry(1, new byte[] { 1, 2, 3 })), (7u, BlobEntry(1, new byte[0])), (9u, BlobEntry(1, blobs[3]))), 0x40)));
        PvVec("BlobSparse-rid2", New("ValueBlobSparseArray", A(Map((1u, BlobEntry(2, new byte[] { 1, 2, 3 }))), 0x40)));
        // strings arrays
        PvVec("WStringArray-empty", New("ValueWStringArray", A(new string[0], 0x20)));
        PvVec("WStringArray", New("ValueWStringArray", A(STRS, 0x20)));
        PvVec("WStringArray-10", New("ValueWStringArray", A(STRS, 0x10)));
        // structs
        PvVec("Struct-empty", New("ValueStruct", A(0x8a0e0001u, 0)));
        PvVec("Struct-1", New("ValueStruct", A(0x8a0e0001u, 0), null, A(Do("AddStructElement", 1u, New("ValueDInt", A(-5, 0))))));
        PvVec("Struct-multi", New("ValueStruct", A(1u, 0), null, A(
            Do("AddStructElement", 1u, New("ValueDInt", A(-5, 0))),
            Do("AddStructElement", 2u, New("ValueWString", A("héllo", 0))),
            Do("AddStructElement", 200u, New("ValueULIntArray", A(new ulong[] { 1, 2, ulong.MaxValue }, 0x10))),
            Do("AddStructElement", 0x4000u, New("ValueStruct", A(77u, 0), null, A(Do("AddStructElement", 3u, New("ValueBool", A(true, 0))))))
        )));
        PvVec("Struct-flags", New("ValueStruct", A(0xffffu, 0x01)));
        foreach (uint id in new uint[] { 0x90000001, 0x90000005, 0x9ffffffe, 0x02000043, 0x02000001, 0x02fffffe, 0x90000000, 0x9fffffff, 0x02000000, 0x02ffffff })
        {
            foreach (var tf in new uint[] { 2, 3, 2 | 0x400 })
                PvVec("StructPacked-" + id.ToString("x") + "-" + tf, New("ValueStruct", A(id, 0), Set(("PackedStructInterfaceTimestamp", 0x10ff4ad6dfd5774cUL), ("PackedStructTransportFlags", tf)), A(
                    Do("AddStructElement", id, New("ValueByteArray", A(new byte[] { 0x07, 0xe8, 5, 20, 0, 12, 30, 15, 0, 0, 1, 2 }, 0x10))))));
        }
        PvVec("StructPacked-empty", New("ValueStruct", A(0x02000043u, 0), Set(("PackedStructInterfaceTimestamp", 1UL)), A(Do("AddStructElement", 0x02000043u, New("ValueByteArray", A(new byte[0], 0x10))))));
        PvVec("StructPacked-nobytes", New("ValueStruct", A(0x02000043u, 0), null, A(Do("AddStructElement", 0x02000043u, New("ValueDInt", A(1, 0))))));
        // duplicate struct key (Dictionary.Add throws)
        Program.Run("pvalue", "Struct-dup", New("ValueStruct", A(1u, 0), null, A(Do("AddStructElement", 1u, New("ValueBool", A(true, 0))), Do("AddStructElement", 1u, New("ValueBool", A(true, 0))))), SER);

        // Hand crafted decode streams: unknown datatypes, odd flags, disableVlq variants
        foreach (var h in new[] { "0000", "0001", "0001ff", "0010", "0010" + "04", "0011", "0012", "0013" + "00", "0030", "0040", "0200", "0300", "0c00", "0a", "", "00", "00" + "80", "00" + "81", "00" + "0f", "0021", "0020", "0070", "0040" + "08" })
            Program.Run("pvalue-dec", "hand-" + h, Static("PValue"), Do("Deserialize", Stream(h), false));
        // disableVlq: 00 flags 00 datatype + fixed encodings
        var DV = new List<(string, byte[])>();
        byte[] Pfx(byte flags, byte dt) => Bytes(0, flags, 0, dt);
        DV.Add(("udint", Cat(Pfx(0, Datatype.UDInt), Enc(s => S7p.EncodeUInt32(s, 0xdeadbeef)))));
        DV.Add(("dint", Cat(Pfx(0, Datatype.DInt), Enc(s => S7p.EncodeInt32(s, -123456)))));
        DV.Add(("ulint", Cat(Pfx(0, Datatype.ULInt), Enc(s => S7p.EncodeUInt64(s, 0x1122334455667788UL)))));
        DV.Add(("lint", Cat(Pfx(0, Datatype.LInt), Enc(s => S7p.EncodeInt64(s, -0x1122334455667788L)))));
        DV.Add(("timespan", Cat(Pfx(0, Datatype.Timespan), Enc(s => S7p.EncodeInt64(s, -5)))));
        DV.Add(("aid", Cat(Pfx(0, Datatype.AID), Enc(s => S7p.EncodeUInt32(s, 0x1234)))));
        DV.Add(("wstring", Cat(Pfx(0, Datatype.WString), Enc(s => S7p.EncodeUInt32(s, 5)), Encoding.UTF8.GetBytes("héllo"))));
        DV.Add(("blob", Cat(Pfx(0, Datatype.Blob), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt32(s, 3)), Bytes(1, 2, 3))));
        DV.Add(("blob2", Cat(Pfx(0, Datatype.Blob), Enc(s => S7p.EncodeUInt32(s, 2)), Bytes(0, 0, 0, 0, 0, 0, 0, 0, 2), Enc(s => S7p.EncodeUInt32(s, 3)), Bytes(1, 2, 3))));
        DV.Add(("udintarr", Cat(Pfx(0x10, Datatype.UDInt), Enc(s => S7p.EncodeUInt32(s, 2)), Enc(s => S7p.EncodeUInt32(s, 7)), Enc(s => S7p.EncodeUInt32(s, 9)))));
        DV.Add(("dintarr", Cat(Pfx(0x10, Datatype.DInt), Enc(s => S7p.EncodeUInt32(s, 2)), Enc(s => S7p.EncodeInt32(s, -7)), Enc(s => S7p.EncodeInt32(s, 9)))));
        DV.Add(("ulintarr", Cat(Pfx(0x10, Datatype.ULInt), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt64(s, 7)))));
        DV.Add(("lintarr", Cat(Pfx(0x10, Datatype.LInt), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeInt64(s, -7)))));
        DV.Add(("timespanarr", Cat(Pfx(0x10, Datatype.Timespan), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeInt64(s, -7)))));
        DV.Add(("aidarr", Cat(Pfx(0x10, Datatype.AID), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt32(s, 77)))));
        DV.Add(("boolarr", Cat(Pfx(0x10, Datatype.Bool), Enc(s => S7p.EncodeUInt32(s, 2)), Bytes(1, 0))));
        DV.Add(("bytearr", Cat(Pfx(0x10, Datatype.Byte), Enc(s => S7p.EncodeUInt32(s, 2)), Bytes(1, 0))));
        DV.Add(("realarr", Cat(Pfx(0x10, Datatype.Real), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeFloat(s, 1.5f)))));
        DV.Add(("udintsparse", Cat(Pfx(0x40, Datatype.UDInt), Enc(s => S7p.EncodeUInt32(s, 7)), Enc(s => S7p.EncodeUInt32(s, 9)), Enc(s => S7p.EncodeUInt32(s, 0)))));
        DV.Add(("dintsparse", Cat(Pfx(0x40, Datatype.DInt), Enc(s => S7p.EncodeUInt32(s, 7)), Enc(s => S7p.EncodeInt32(s, -9)), Enc(s => S7p.EncodeUInt32(s, 0)))));
        DV.Add(("wstringarr", Cat(Pfx(0x20, Datatype.WString), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt32(s, 2)), Encoding.UTF8.GetBytes("hi"))));
        DV.Add(("wstringsparse", Cat(Pfx(0x40, Datatype.WString), Enc(s => S7p.EncodeUInt32(s, 7)), Enc(s => S7p.EncodeUInt32(s, 2)), Encoding.UTF8.GetBytes("hi"), Enc(s => S7p.EncodeUInt32(s, 0)))));
        DV.Add(("blobarr", Cat(Pfx(0x20, Datatype.Blob), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt32(s, 1)), Enc(s => S7p.EncodeUInt32(s, 2)), Bytes(1, 2))));
        DV.Add(("struct", Cat(Pfx(0, Datatype.Struct), Enc(s => S7p.EncodeUInt32(s, 0x8a0e0001)), Enc(s => S7p.EncodeUInt32(s, 1)), Pfx(0, Datatype.UDInt), Enc(s => S7p.EncodeUInt32(s, 5)), Enc(s => S7p.EncodeUInt32(s, 0)))));
        DV.Add(("structpacked", Cat(Pfx(0, Datatype.Struct), Enc(s => S7p.EncodeUInt32(s, 0x02000043)), Enc(s => S7p.EncodeUInt64(s, 0x1122334455667788UL)), Enc(s => S7p.EncodeUInt32(s, 2)), Enc(s => S7p.EncodeUInt32(s, 3)), Bytes(7, 8, 9))));
        DV.Add(("structpacked2", Cat(Pfx(0, Datatype.Struct), Enc(s => S7p.EncodeUInt32(s, 0x02000043)), Enc(s => S7p.EncodeUInt64(s, 0x1122334455667788UL)), Enc(s => S7p.EncodeUInt32(s, 0x402)), Enc(s => S7p.EncodeUInt32(s, 99)), Enc(s => S7p.EncodeUInt32(s, 3)), Bytes(7, 8, 9))));
        DV.Add(("bool", Cat(Pfx(0, Datatype.Bool), Bytes(1))));
        foreach (var (n, b) in DV)
        {
            Program.Run("pvalue-dec", "novlq-" + n, Static("PValue"), Do("Deserialize", Stream(b), true));
            Program.Run("pvalue-dec", "novlq-trunc-" + n, Static("PValue"), Do("Deserialize", Stream(b.Take(b.Length - 1).ToArray()), true));
        }
        // ToString helpers
        foreach (var ts in new ulong[] { 0, 1, 1000, 1700000000000000000UL, 1700000000123456789UL })
            Program.Run("pvalue", "timestampToString-" + ts, Static("ValueTimestamp"), Do("ToString", ts));
        foreach (var ts in new long[] { 0, 1, -1, 1000, 86400000000000L, -86400000000000L, 93784123456789L, long.MaxValue, long.MinValue + 1 })
            Program.Run("pvalue", "timespanToString-" + ts, Static("ValueTimespan"), Do("ToString", ts));
    }
}
