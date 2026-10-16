using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using static Interp;

static partial class Gen
{
    static object[] TagValues(string cls, Type vt)
    {
        switch (cls)
        {
            case "PlcTagDate": return new object[] { new DateTime(1990, 1, 1), new DateTime(1990, 1, 2), new DateTime(2000, 2, 29), new DateTime(2024, 12, 31), new DateTime(2169, 6, 6), new DateTime(2169, 6, 7), new DateTime(1989, 12, 31), new DateTime(2200, 1, 1) };
            case "PlcTagDateAndTime": return new object[] { new DateTime(1990, 1, 1), new DateTime(1999, 12, 31, 23, 59, 59, 999), new DateTime(2000, 1, 1), new DateTime(2024, 5, 17, 13, 45, 59, 123), new DateTime(2089, 12, 31, 23, 59, 59, 999), new DateTime(2090, 1, 1), new DateTime(1989, 1, 1), new DateTime(2024, 5, 17, 3, 4, 5, 7) };
            case "PlcTagDTL": return new object[] { new DateTime(1970, 1, 1), new DateTime(2000, 2, 29, 1, 2, 3), new DateTime(2024, 12, 31, 23, 59, 59), new DateTime(2262, 4, 11, 23, 47, 16), new DateTime(1969, 12, 31), new DateTime(2300, 1, 1) };
            case "PlcTagDateAndTimeArray": return new object[] { new DateTime[0], new[] { new DateTime(1990, 1, 1) }, new[] { new DateTime(2024, 5, 17, 13, 45, 59, 123), new DateTime(1999, 12, 31, 23, 59, 59, 999), new DateTime(2000, 1, 1, 0, 0, 0, 10) } };
            case "PlcTagTimeOfDay": return new object[] { 0u, 1u, 3723000u, 86399999u, 86400000u, 0xffffffffu };
            case "PlcTagLTOD": return new object[] { 0UL, 1UL, 3723000000000UL, 86399999999999UL, 86400000000000UL, ulong.MaxValue };
            case "PlcTagString": return new object[] { "", "a", "Hello", "Hällo", new string('x', 254), new string('x', 255), "日" };
            case "PlcTagWString": return new object[] { "", "a", "Hello", "Hällo 日本", new string('x', 254), new string('x', 255), "\U0001F600" };
            case "PlcTagStringArray": return new object[] { new string[0], new[] { "a" }, new[] { "abc", "", "Hällo" }, new[] { new string('y', 255) } };
            case "PlcTagPointer": return new object[] { new byte[] { 1, 2, 3, 4, 5, 6 }, new byte[6], new byte[] { 255, 255, 255, 255, 255, 255 }, new byte[] { 1, 2 } };
            case "PlcTagAny": return new object[] { new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }, new byte[10], new byte[] { 255, 0, 255, 0, 255, 0, 255, 0, 255, 0 } };
            case "PlcTagChar": return new object[] { "A", "z", "ä", "\u0000", "ÿ" };
            case "PlcTagWChar": return new object[] { "A", "z", "ä", "日", "￿", "\u0000" };
        }
        if (vt == typeof(bool)) return new object[] { true, false };
        if (vt == typeof(byte)) return new object[] { (byte)0, (byte)1, (byte)127, (byte)255 };
        if (vt == typeof(sbyte)) return new object[] { (sbyte)0, (sbyte)-1, (sbyte)127, (sbyte)-128 };
        if (vt == typeof(ushort)) return U16.Cast<object>().ToArray();
        if (vt == typeof(short)) return I16.Cast<object>().ToArray();
        if (vt == typeof(uint)) return U32.Cast<object>().ToArray();
        if (vt == typeof(int)) return I32.Cast<object>().ToArray();
        if (vt == typeof(ulong)) return U64.Cast<object>().ToArray();
        if (vt == typeof(long)) return I64.Cast<object>().ToArray();
        if (vt == typeof(float)) return FL.Cast<object>().ToArray();
        if (vt == typeof(double)) return DB.Cast<object>().ToArray();
        if (vt == typeof(bool[])) return new object[] { new[] { true }, new[] { true, false, true }, new bool[9], new bool[0] };
        if (vt == typeof(byte[])) return new object[] { new byte[] { 0 }, new byte[] { 1, 2, 255 }, new byte[0], Enumerable.Range(0, 20).Select(x => (byte)x).ToArray() };
        if (vt == typeof(sbyte[])) return new object[] { new sbyte[] { 0 }, new sbyte[] { 1, -2, 127, -128 }, new sbyte[0] };
        if (vt == typeof(ushort[])) return new object[] { new ushort[] { 0 }, new ushort[] { 1, 2, 65535 }, new ushort[0] };
        if (vt == typeof(short[])) return new object[] { new short[] { 0 }, new short[] { 1, -2, 32767, -32768 }, new short[0] };
        if (vt == typeof(uint[])) return new object[] { new uint[] { 0 }, new uint[] { 1, 2, uint.MaxValue }, new uint[0] };
        if (vt == typeof(int[])) return new object[] { new int[] { 0 }, new[] { 1, -2, int.MaxValue, int.MinValue }, new int[0] };
        if (vt == typeof(float[])) return new object[] { new float[] { 0 }, new[] { 1.5f, -2.25f, float.MaxValue }, new float[0] };
        return new object[0];
    }

    static void GenTags()
    {
        var tagTypes = Asm.GetTypes().Where(t => typeof(PlcTag).IsAssignableFrom(t) && !t.IsAbstract).OrderBy(t => t.Name).ToList();
        var addr = IA("8A0E000F.9");
        foreach (var tt in tagTypes)
        {
            string cls = tt.Name;
            var vp = tt.GetProperty("Value");
            if (cls == "PlcTagS5Time")
            {
                foreach (var (tv, tb) in new[] { (0, 0), (1, 0), (999, 0), (123, 1), (45, 2), (7, 3), (1000, 0), (5, 4), (990, 3), (100, 2) })
                {
                    var spec = New(cls, A("t", addr, 7u), Set(("TimeValue", tv), ("TimeBase", tb)));
                    var v = Program.Run("tag", cls + "-" + tv + "-" + tb, spec, Do("GetWriteValue"), STR, DUMP);
                    ReadVec(cls, v, spec);
                }
                continue;
            }
            var vals = TagValues(cls, vp.PropertyType);
            if (vals.Length == 0) { Console.WriteLine("no values for " + cls); continue; }
            int i = 0;
            foreach (var val in vals)
            {
                var ctorArgs = A("tag", addr, 7u);
                JsonObject spec;
                if (cls == "PlcTagString") spec = New(cls, A("tag", addr, 7u, 20), Set(("Value", val)));
                else if (cls == "PlcTagWString") spec = New(cls, A("tag", addr, 7u, 20), Set(("Value", val)));
                else if (cls == "PlcTagStringArray") spec = New(cls, A("tag", addr, 7u, 20), Set(("Value", val)));
                else if (cls == "PlcTagDTL") spec = New(cls, A("tag", addr, 7u), Set(("Value", val), ("ValueNanosecond", (uint)(1234567 * (i + 1)))));
                else spec = New(cls, ctorArgs, Set(("Value", val)));
                var v = Program.Run("tag", cls + "-" + i, spec, Do("GetWriteValue"), STR, DUMP);
                ReadVec(cls, v, spec);
                i++;
            }
            // default state
            Program.Run("tag", cls + "-default", New(cls, A("tag", addr, 7u)), Do("GetWriteValue"), STR, DUMP);
            // string encodings
            if (cls == "PlcTagString" || cls == "PlcTagStringArray")
                foreach (var enc in new[] { "ISO-8859-1", "utf-8", "us-ascii" })
                    Program.Run("tag", cls + "-enc-" + enc, New(cls, A("tag", addr, 7u, 30), Set(("Value", cls == "PlcTagString" ? (object)"Hällo 日" : new[] { "Hällo 日", "x" })), A(Do("SetStringEncoding", enc))), Do("GetWriteValue"), STR);
            if (cls == "PlcTagChar")
                foreach (var enc in new[] { "ISO-8859-1", "utf-8", "us-ascii" })
                    Program.Run("tag", cls + "-enc-" + enc, New(cls, A("tag", addr, 7u), Set(("Value", "ä")), A(Do("SetCharEncoding", enc))), Do("GetWriteValue"), STR);
        }
        // Error / wrong type handling
        foreach (var cls in new[] { "PlcTagInt", "PlcTagBool", "PlcTagDTL", "PlcTagString" })
        {
            Program.Run("tag", cls + "-err", New(cls, A("tag", addr, 7u)), Do("ProcessReadResult", New("ValueNull"), 5UL), DUMP, STR);
            Program.Run("tag", cls + "-wrongtype", New(cls, A("tag", addr, 7u)), Do("ProcessReadResult", New("ValueWString", A("x", 0)), 0UL), DUMP, STR);
            Program.Run("tag", cls + "-writeerr", New(cls, A("tag", addr, 7u)), Do("ProcessWriteResult", 0x8104UL), DUMP);
        }
        // Hand crafted reads
        void Raw(string cls, string id, byte[] pv, params JsonArray[] extra) =>
            Program.Run("tag-raw", cls + "-" + id, New(cls, A("tag", addr, 7u)), new[] { Do("ProcessReadResult", new JsonObject { ["$pv"] = Hex(pv) }, 0UL), DUMP, STR }.Concat(extra).ToArray());
        byte[] USArr(params int[] b) => Ser(New("ValueUSIntArray", A(b.Select(x => (byte)x).ToArray(), 0x10)));
        Raw("PlcTagDateAndTime", "bcd1", USArr(0x24, 0x05, 0x17, 0x13, 0x45, 0x59, 0x12, 0x33));
        Raw("PlcTagDateAndTime", "bcd90", USArr(0x90, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01));
        Raw("PlcTagDateAndTime", "bcd89", USArr(0x89, 0x12, 0x31, 0x23, 0x59, 0x59, 0x99, 0x97));
        Raw("PlcTagDateAndTime", "bcdbad", USArr(0x24, 0x13, 0x45, 0x25, 0x61, 0x61, 0x99, 0x97));
        Raw("PlcTagDateAndTimeArray", "bcd2", USArr(0x24, 0x05, 0x17, 0x13, 0x45, 0x59, 0x12, 0x33, 0x99, 0x12, 0x31, 0x23, 0x59, 0x59, 0x99, 0x97));
        Raw("PlcTagDateAndTimeArray", "bcd1", USArr(0x24, 0x05, 0x17, 0x13, 0x45, 0x59, 0x12, 0x33));
        Raw("PlcTagDateAndTimeArray", "bcd-short", USArr(0x24, 0x05, 0x17, 0x13, 0x45, 0x59, 0x12));
        Raw("PlcTagString", "raw", USArr(20, 5, 72, 101, 108, 108, 111, 0, 0, 0));
        Raw("PlcTagString", "raw-latin", USArr(20, 2, 0xe4, 0xfc));
        Raw("PlcTagString", "raw-short", USArr(20, 9, 72, 101));
        Raw("PlcTagString", "raw-toolong", Ser(New("ValueUSIntArray", A(new byte[] { 255, 255 }.Concat(Enumerable.Repeat((byte)65, 255)).ToArray(), 0x10))));
        Raw("PlcTagStringArray", "raw2", USArr(5, 2, 65, 66, 0, 0, 0, 0, 5, 3, 67, 68, 69, 0, 0, 0));
        Raw("PlcTagWString", "raw", Ser(New("ValueUIntArray", A(new ushort[] { 20, 3, 0, 0, 72, 0xe4, 0x65e5 }, 0x10))));
        Raw("PlcTagWString", "raw-short", Ser(New("ValueUIntArray", A(new ushort[] { 20, 9, 0, 0, 72 }, 0x10))));
        Raw("PlcTagDTL", "ok", Ser(New("ValueStruct", A(0x02000043u, 0), Set(("PackedStructInterfaceTimestamp", 77UL)), A(Do("AddStructElement", 0x02000043u, New("ValueByteArray", A(new byte[] { 0x07, 0xe8, 5, 17, 5, 13, 45, 59, 0, 0, 3, 0xe8 }, 0x10)))))));
        Raw("PlcTagDTL", "wrongid", Ser(New("ValueStruct", A(0x02000044u, 0), null, A(Do("AddStructElement", 0x02000044u, New("ValueByteArray", A(new byte[] { 0x07, 0xe8, 5, 17, 5, 13, 45, 59, 0, 0, 3, 0xe8 }, 0x10)))))));
        Raw("PlcTagDTL", "badmonth", Ser(New("ValueStruct", A(0x02000043u, 0), null, A(Do("AddStructElement", 0x02000043u, New("ValueByteArray", A(new byte[] { 0x07, 0xe8, 13, 17, 5, 13, 45, 59, 0, 0, 3, 0xe8 }, 0x10)))))));
        Raw("PlcTagDTL", "notbytes", Ser(New("ValueStruct", A(0x02000043u, 0), null, A(Do("AddStructElement", 0x02000043u, New("ValueDInt", A(1, 0)))))));
        Raw("PlcTagDate", "days", Ser(New("ValueUInt", A(0, 0))));
        Raw("PlcTagDate", "days2", Ser(New("ValueUInt", A(12345, 0))));
        Raw("PlcTagDate", "daysmax", Ser(New("ValueUInt", A(65535, 0))));
        Raw("PlcTagS5Time", "w", Ser(New("ValueWord", A(2457, 0))));
        Raw("PlcTagS5Time", "w2", Ser(New("ValueWord", A(14745, 0))));
        Raw("PlcTagS5Time", "wmax", Ser(New("ValueWord", A(0xffff, 0))));
        Raw("PlcTagS5Time", "bad-bcd", Ser(New("ValueWord", A(0x0fff, 0))));
        Raw("PlcTagTime", "ts", Ser(New("ValueTimespan", A(3723000L * 1000000L, 0))));
        Raw("PlcTagLTime", "ts", Ser(New("ValueTimespan", A(-5L, 0))));
        Raw("PlcTagLDT", "ts", Ser(New("ValueTimestamp", A(1700000000000000000UL, 0))));
        Raw("PlcTagTimeOfDay", "big", Ser(New("ValueUDInt", A(86400000u, 0))));
        Raw("PlcTagPointer", "raw", Ser(New("ValueByteArray", A(new byte[] { 1, 2, 3, 4, 5, 6 }, 0x10))));
        Raw("PlcTagPointer", "short", Ser(New("ValueByteArray", A(new byte[] { 1, 2 }, 0x10))));
        Raw("PlcTagAny", "raw", Ser(New("ValueByteArray", A(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }, 0x10))));
        Raw("PlcTagChar", "raw", Ser(New("ValueUSInt", A(0xe4, 0))));
        Raw("PlcTagWChar", "raw", Ser(New("ValueUInt", A(0x65e5, 0))));
        Raw("PlcTagBoolArray", "raw", Ser(New("ValueBoolArray", A(new[] { true, false, true }, 0x10))));
    }

    static void ReadVec(string cls, JsonObject writeVec, JsonObject spec)
    {
        if (writeVec.ContainsKey("buildErr")) return;
        var r = writeVec["expect"][0];
        if (r["err"] != null || r["ret"] == null) return;
        var hex = (string)r["ret"]["hex"];
        if (hex == null || hex.StartsWith("<")) return;
        var fresh = spec.DeepClone().AsObject();
        fresh.Remove("set");
        // keep ctor args only (fresh tag), then process the produced PValue
        Program.Run("tag-read", cls + "-" + (string)writeVec["id"], fresh, Do("ProcessReadResult", new JsonObject { ["$pv"] = hex }, 0UL), DUMP, STR, Do("GetWriteValue"));
    }

    static System.Reflection.Assembly Asm => Interp.Asm;
}
