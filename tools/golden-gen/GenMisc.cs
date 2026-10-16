using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using ComponentAce.Compression.Libs.zlib;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    static JsonObject Blob(uint rid, byte[] b) => New("ValueBlob", A(rid, b, 0));

    static void GenAlarms()
    {
        // HmiInfo
        byte[] Hmi(int syntax, int total)
        {
            var ms = new MemoryStream();
            S7p.EncodeUInt16(ms, (ushort)syntax); S7p.EncodeUInt16(ms, 3); S7p.EncodeUInt32(ms, 0xdeadbeef); ms.WriteByte(7);
            if (syntax >= 257) { ms.WriteByte(1); ms.WriteByte(2); ms.WriteByte(3); if (syntax >= 258) { S7p.EncodeUInt16(ms, 0x1234); ms.WriteByte(4); ms.WriteByte(5); ms.WriteByte(6); } }
            var b = ms.ToArray(); return b.Take(total < 0 ? b.Length : total).ToArray();
        }
        foreach (var syn in new[] { 0, 1, 256, 257, 258, 300 })
        {
            var b = Hmi(syn, -1);
            Program.Run("alarm", "hmi-blob-" + syn, Static("AlarmsHmiInfo"), Do("FromValueBlob", Blob(1, b)));
            Program.Run("alarm", "hmi-deser-" + syn, New("AlarmsHmiInfo"), Do("Deserialize", Stream(b)), DUMP, STR);
            Program.Run("alarm", "hmi-blob-short-" + syn, Static("AlarmsHmiInfo"), Do("FromValueBlob", Blob(1, b.Take(b.Length - 1).ToArray())));
            Program.Run("alarm", "hmi-deser-short-" + syn, New("AlarmsHmiInfo"), Do("Deserialize", Stream(b.Take(b.Length - 1).ToArray())), DUMP);
        }
        // MultipleStai
        foreach (var lids in new[] { new uint[0], new uint[] { 5 }, new uint[] { 1, 2, 0xffffffff } })
            foreach (var syn in new[] { 256, 258 })
            {
                var hb = Hmi(syn, -1);
                var ms = new MemoryStream();
                S7p.EncodeUInt16(ms, 9); S7p.EncodeUInt16(ms, 256); S7p.EncodeUInt16(ms, 2); ms.WriteByte(1); S7p.EncodeUInt16(ms, (ushort)hb.Length); ms.Write(hb, 0, hb.Length);
                S7p.EncodeUInt16(ms, (ushort)lids.Length); foreach (var l in lids) S7p.EncodeUInt32(ms, l);
                var b = ms.ToArray();
                Program.Run("alarm", "stai-" + syn + "-" + lids.Length, New("AlarmsMultipleStai"), Do("Deserialize", Stream(b)), DUMP, STR);
                Program.Run("alarm", "stai-trunc-" + syn + "-" + lids.Length, New("AlarmsMultipleStai"), Do("Deserialize", Stream(b.Take(b.Length - 2).ToArray())), DUMP);
            }
        // AssociatedValues
        byte[] BE16(int v) => Bytes(v >> 8, v);
        var items = new List<JsonObject> { Blob(3476, new byte[] { 0, 1, 2, 3 }) };
        items.Add(Blob(Ids.TI_BOOL, new byte[] { 1 }));
        items.Add(Blob(Ids.TI_BYTE, new byte[] { 200 }));
        items.Add(Blob(Ids.TI_CHAR, new byte[] { 0xe4 }));
        items.Add(Blob(Ids.TI_WORD, BE16(0xfffe)));
        items.Add(Blob(Ids.TI_INT, BE16(0x8001)));
        items.Add(Blob(Ids.TI_DWORD, U32b(0xfffffffe)));
        items.Add(Blob(Ids.TI_DINT, U32b(0x80000001)));
        items.Add(Blob(Ids.TI_REAL, Enc(s => S7p.EncodeFloat(s, 3.14159274f))));
        items.Add(Blob(Ids.TI_LREAL, Enc(s => S7p.EncodeDouble(s, 1e-30))));
        items.Add(Blob(Ids.TI_USINT, new byte[] { 255 }));
        var fullBlob = New("ValueBlobArray", A(items.ToArray(), 0x20));
        Program.Run("alarm", "assoc-1", Static("AlarmsAssociatedValues"), Do("FromValueBlob", fullBlob));
        var items2 = new List<JsonObject> { Blob(3476, new byte[] { 0, 1, 2, 3 }) };
        items2.Add(Blob(Ids.TI_UINT, BE16(65535)));
        items2.Add(Blob(Ids.TI_UDINT, U32b(4000000000)));
        items2.Add(Blob(Ids.TI_SINT, new byte[] { 0x80 }));
        items2.Add(Blob(Ids.TI_WCHAR, BE16(0x65e5)));
        items2.Add(Blob(Ids.TI_STRING_START + 10, Cat(Bytes(10, 5), Encoding.Latin1.GetBytes("Hällo"), new byte[5])));
        items2.Add(Blob(Ids.TI_WSTRING_START + 10, Cat(BE16(10), BE16(3), Encoding.BigEndianUnicode.GetBytes("a日b"), new byte[14])));
        items2.Add(Blob(0x7777, new byte[] { 1 }));
        items2.Add(Blob(Ids.TI_REAL, Enc(s => S7p.EncodeFloat(s, 1e10f))));
        items2.Add(Blob(Ids.TI_LREAL, Enc(s => S7p.EncodeDouble(s, 123456.789))));
        items2.Add(Blob(Ids.TI_LREAL, Enc(s => S7p.EncodeDouble(s, -0.0))));
        items2.Add(Blob(Ids.TI_BOOL, new byte[] { 0 }));
        Program.Run("alarm", "assoc-2", Static("AlarmsAssociatedValues"), Do("FromValueBlob", New("ValueBlobArray", A(items2.ToArray(), 0x20))));
        foreach (var fv in new float[] { 0.1f, 1e-5f, 123456789f, 1e20f, -1.5f, float.NaN, float.PositiveInfinity, 16777217f })
            Program.Run("alarm", "assoc-real-" + fv, Static("AlarmsAssociatedValues"), Do("FromValueBlob", New("ValueBlobArray", A(new[] { Blob(0, new byte[4]), Blob(Ids.TI_REAL, Enc(s => S7p.EncodeFloat(s, fv))) }, 0x20))));
        foreach (var dv in new double[] { 0.1, 1e-5, 1e15, 1e16, 123456789012345678.0, 1e300, 5e-324, -2.5, double.NaN, double.NegativeInfinity, 100.0 / 3.0 })
            Program.Run("alarm", "assoc-lreal-" + dv, Static("AlarmsAssociatedValues"), Do("FromValueBlob", New("ValueBlobArray", A(new[] { Blob(0, new byte[4]), Blob(Ids.TI_LREAL, Enc(s => S7p.EncodeDouble(s, dv))) }, 0x20))));
        Program.Run("alarm", "assoc-empty", Static("AlarmsAssociatedValues"), Do("FromValueBlob", New("ValueBlobArray", A(new JsonObject[0], 0x20))));
        Program.Run("alarm", "assoc-short", Static("AlarmsAssociatedValues"), Do("FromValueBlob", New("ValueBlobArray", A(new[] { Blob(0, new byte[4]), Blob(Ids.TI_DINT, new byte[2]) }, 0x20))));
        // AlarmTexts
        uint K(int lcid, int tid) => (uint)((lcid << 16) | tid);
        var sparse = Map(
            (K(1031, 1), BlobEntry(1, Encoding.UTF8.GetBytes("Info ä"))), (K(1031, 2), BlobEntry(1, Encoding.UTF8.GetBytes("Alarm text"))),
            (K(1031, 3), BlobEntry(1, Encoding.UTF8.GetBytes("a1"))), (K(1031, 11), BlobEntry(1, Encoding.UTF8.GetBytes("a9"))), (K(1031, 12), BlobEntry(1, Encoding.UTF8.GetBytes("ignored"))),
            (K(1033, 1), BlobEntry(1, Encoding.UTF8.GetBytes("English info"))), (K(1033, 2), BlobEntry(1, new byte[0])));
        foreach (var lang in new[] { 1031, 1033, 1, 0 })
            Program.Run("alarm", "texts-" + lang, Static("AlarmsAlarmTexts"), Do("FromNotificationBlob", New("ValueBlobSparseArray", A(sparse, 0x40)), lang));
        // Dai
        var tsv = 1700000000123456789UL;
        JsonObject AsCgs(bool going) => New("ValueStruct", A(0x1u, 0), null, A(
            Do("AddStructElement", (uint)Ids.AS_CGS_AllStatesInfo, New("ValueUSInt", A(3, 0))),
            Do("AddStructElement", (uint)Ids.AS_CGS_Timestamp, New("ValueTimestamp", A(tsv, 0))),
            Do("AddStructElement", (uint)Ids.AS_CGS_AssociatedValues, fullBlob),
            Do("AddStructElement", (uint)Ids.AS_CGS_AckTimestamp, New("ValueTimestamp", A(tsv + 5000000000UL, 0)))));
        JsonObject DaiObj(int which)
        {
            var d = new JsonArray {
                Do("AddAttribute", (uint)Ids.ObjectVariableTypeName, New("ValueWString", A("Alarm.Type", 0))),
                Do("AddAttribute", (uint)Ids.DAI_CPUAlarmID, New("ValueLWord", A(0x1122334455667788UL, 0))),
                Do("AddAttribute", (uint)Ids.DAI_AllStatesInfo, New("ValueUSInt", A(9, 0))),
                Do("AddAttribute", (uint)Ids.DAI_AlarmDomain, New("ValueUInt", A(258, 0))),
                Do("AddAttribute", (uint)Ids.DAI_MessageType, New("ValueDInt", A(2, 0))),
                Do("AddAttribute", (uint)Ids.DAI_HmiInfo, Blob(1, Hmi(258, -1))),
                Do("AddAttribute", (uint)Ids.DAI_SequenceCounter, New("ValueUDInt", A(77u, 0))),
                Do("AddAttribute", (uint)Ids.DAI_AlarmTexts_Rid, New("ValueBlobSparseArray", A(sparse, 0x40))),
            };
            if (which == 0) d.Add(Do("AddAttribute", (uint)Ids.DAI_Coming, AsCgs(false)));
            if (which == 1) d.Add(Do("AddAttribute", (uint)Ids.DAI_Going, AsCgs(true)));
            return New("PObject", A(1u, 2u, 3u), null, d);
        }
        for (int w = 0; w < 3; w++)
            Program.Run("alarm", "dai-" + w, Static("AlarmsDai"), Do("FromNotificationObject", DaiObj(w), 1031));
        Program.Run("alarm", "ascgs", Static("AlarmsAsCgs"), Do("FromValueStruct", AsCgs(false)));
    }

    static void GenBlob()
    {
        string[] samples = {
            "<Root>hello</Root>",
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><Interface xmlns=\"http://www.siemens.com/automation/Openness/SW/Interface/v5\"><Sections><Section Name=\"Input\"><Member Name=\"x\" Datatype=\"Int\" /></Section></Sections></Interface>",
            "unicode äöü 日本語 \U0001F600",
            "",
            string.Concat(Enumerable.Repeat("<Member Name=\"abc\" Datatype=\"Bool\"/>", 2000)),  // > 16384 bytes
        };
        var dictFields = typeof(BlobDecompressor).GetFields(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public).Where(f => f.Name.StartsWith("dict_") && f.FieldType == typeof(byte[])).ToList();
        Console.WriteLine("dictionaries: " + dictFields.Count);
        var ok = 0;
        byte[] Deflate(byte[] data, byte[] dict)
        {
            var z = new ZStream();
            z.deflateInit(zlibConst.Z_DEFAULT_COMPRESSION);
            if (dict != null) { int r = z.deflateSetDictionary(dict, dict.Length); if (r != 0) throw new Exception("setdict " + r); }
            var outbuf = new byte[data.Length + 1024];
            z.next_in = data; z.next_in_index = 0; z.avail_in = data.Length;
            z.next_out = outbuf; z.next_out_index = 0; z.avail_out = outbuf.Length;
            int rc = z.deflate(zlibConst.Z_FINISH);
            if (rc != zlibConst.Z_STREAM_END) throw new Exception("deflate rc " + rc);
            var res = outbuf.Take((int)z.total_out).ToArray();
            z.deflateEnd();
            return res;
        }
        int si = 0;
        foreach (var s in samples)
        {
            var data = Encoding.UTF8.GetBytes(s);
            var plain = Deflate(data, null);
            Program.Run("blob", "plain-" + si, New("BlobDecompressor"), Do("decompress", plain, 0), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), plain), 4), Do("decompress", plain, 1), Do("decompress", plain.Take(plain.Length / 2).ToArray(), 0), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), plain.Take(plain.Length / 2).ToArray()), 4), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), plain.Take(Math.Max(0, plain.Length - 2)).ToArray()), 4), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), plain), 3), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), plain, Bytes(1, 2, 3)), 4));
            foreach (var df in dictFields)
            {
                var dict = (byte[])df.GetValue(null);
                try
                {
                    var c = Deflate(data, dict);
                    var vec = Program.Run("blob", "dict-" + df.Name + "-" + si, New("BlobDecompressor"), Do("decompress", c, 0), Do("decompress", Cat(Bytes(0x90, 0, 0, 1), c), 4));
                    if ((string)vec["expect"][0]["ret"] == s) ok++;
                }
                catch (Exception e) { Console.WriteLine("dict " + df.Name + ": " + e.Message); }
            }
            si++;
        }
        Console.WriteLine("blob dict roundtrips ok in C#: " + ok);
        Program.Run("blob", "garbage", New("BlobDecompressor"), Do("decompress", new byte[] { 1, 2, 3, 4, 5, 6 }, 0), Do("decompress", new byte[0], 0), Do("decompress", new byte[] { 0x78, 0x9c }, 0), Do("decompress", new byte[] { 0x78, 0x9c, 0xff, 0xff }, 0), Do("decompress", new byte[] { 0x78, 0x9c }, 5));
        Program.Run("blob", "unknown-dict", New("BlobDecompressor"), Do("decompress", new byte[] { 0x78, 0xbb, 0x12, 0x34, 0x56, 0x78, 1, 2, 3 }, 0));
    }
}
