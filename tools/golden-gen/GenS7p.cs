using System.Text;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    public static readonly uint[] U32 = { 0, 1, 0x3f, 0x40, 0x7f, 0x80, 0xff, 0x100, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0xfffffff, 0x10000000, 0x12345678, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff };
    public static readonly int[] I32 = { 0, 1, -1, 63, 64, -64, -65, 127, -128, 8191, 8192, -8192, -8193, 1048575, -1048576, 134217727, 134217728, -134217728, 123456789, -123456789, int.MaxValue, int.MinValue, int.MinValue + 1 };
    public static readonly ulong[] U64 = { 0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0xffffffff, 0x100000000, 0xffffffffff, 0x1ffffffffffffff, 0x100000000000000, 0xfedcba9876543210, 0x7fffffffffffffff, 0x8000000000000000, 0xffffffffffffffff, 0xff00000000000000, 72057594037927935, 72057594037927936 };
    public static readonly long[] I64 = { 0, 1, -1, 63, 64, -64, -65, 8191, -8192, 0x7fffffff, 0x80000000, -0x80000000L, -0x80000001L, 0x00ffffffffffffff, 0x0100000000000000, -0x0100000000000000, 0x7fffffffffffffff, long.MinValue, long.MinValue + 1, 1234567890123456789, -1234567890123456789 };
    public static readonly ushort[] U16 = { 0, 1, 0xff, 0x100, 0x7fff, 0x8000, 0x1234, 0xffff };
    public static readonly short[] I16 = { 0, 1, -1, 127, -128, 255, 256, 0x7fff, -0x8000, 0x1234, -0x1234 };
    public static readonly float[] FL = { 0f, 1f, -1f, 1.5f, -2.25f, 3.14159274f, float.MaxValue, float.MinValue, float.Epsilon, 1e-30f, float.PositiveInfinity, float.NegativeInfinity, -0f, float.NaN, 16777216f, 0.1f };
    public static readonly double[] DB = { 0, 1, -1, 1.5, -2.25, Math.PI, double.MaxValue, double.MinValue, double.Epsilon, 1e-300, double.PositiveInfinity, double.NegativeInfinity, -0.0, double.NaN, 9007199254740993.0, 0.1 };
    public static readonly string[] STRS = { "", "a", "abc", "héllo wörld", "日本語", "emoji \U0001F600 end", new string('x', 127), new string('y', 128), new string('ä', 200), "a\u0000b", "€" };

    static void GenS7p()
    {
        void Enc1(string op, IEnumerable<object> vals, Func<object, byte[]> decodeHex = null)
        {
            foreach (var v in vals)
            {
                var vec = Program.Run("s7p", "enc-" + op + "-" + J(v).ToJsonString(), Static("S7p"), Do(op, W(), v));
                // decode counterpart
                var hex = (string)vec["expect"][0]["hex"];
                if (hex == null) continue;
                string dop = op.Replace("Encode", "Decode");
                foreach (var h in new[] { hex, hex + "ff00", hex.Substring(0, Math.Max(0, hex.Length - 2)), "" })
                    Program.Run("s7p", "dec-" + op + "-" + J(v).ToJsonString() + "-" + h.Length, Static("S7p"), Do(dop, Stream(h)));
            }
        }
        Enc1("EncodeByte", new object[] { 0, 1, 127, 128, 255 });
        Enc1("EncodeUInt16", U16.Cast<object>());
        Enc1("EncodeInt16", I16.Cast<object>());
        Enc1("EncodeUInt32", U32.Cast<object>());
        Enc1("EncodeInt32", I32.Cast<object>());
        Enc1("EncodeUInt64", U64.Cast<object>());
        Enc1("EncodeInt64", I64.Cast<object>());
        Enc1("EncodeUInt32Vlq", U32.Cast<object>());
        Enc1("EncodeInt32Vlq", I32.Cast<object>());
        Enc1("EncodeUInt64Vlq", U64.Cast<object>());
        Enc1("EncodeInt64Vlq", I64.Cast<object>());
        Enc1("EncodeFloat", FL.Cast<object>());
        Enc1("EncodeDouble", DB.Cast<object>());
        // LE decoders on arbitrary data
        var rnd = new Random(1234);
        for (int i = 0; i < 40; i++)
        {
            var b = new byte[rnd.Next(0, 12)]; rnd.NextBytes(b);
            string h = Hex(b);
            foreach (var d in new[] { "DecodeByte", "DecodeUInt16", "DecodeUInt16LE", "DecodeInt16", "DecodeUInt32", "DecodeUInt32LE", "DecodeInt32LE", "DecodeInt32", "DecodeUInt64", "DecodeInt64", "DecodeUInt32Vlq", "DecodeInt32Vlq", "DecodeUInt64Vlq", "DecodeInt64Vlq", "DecodeFloat", "DecodeDouble" })
                Program.Run("s7p", "rnd-" + d + "-" + i, Static("S7p"), Do(d, Stream(h)));
        }
        // Maximal length / unterminated VLQs
        foreach (var h in new[] { "80", "8080", "808080", "80808080", "8080808080", "ffffffffff", "ffffffffffffffffff", "ffffffffffffffffffff", "81808080808080808000", "ffffffffffffffff7f", "ffffffffffffffffff7f", "bfffffffffffffff80", "c0808080808080808001" })
            foreach (var d in new[] { "DecodeUInt32Vlq", "DecodeInt32Vlq", "DecodeUInt64Vlq", "DecodeInt64Vlq" })
                Program.Run("s7p", "vlq-" + d + "-" + h, Static("S7p"), Do(d, Stream(h)));
        // strings & octets
        foreach (var s in STRS)
        {
            var vec = Program.Run("s7p", "encWString-" + s.Length, Static("S7p"), Do("EncodeWString", W(), s));
            var hex = (string)vec["expect"][0]["hex"];
            int n = hex.Length / 2;
            Program.Run("s7p", "decWString-" + s.Length, Static("S7p"), Do("DecodeWString", Stream(hex), n));
            Program.Run("s7p", "decWStringShort-" + s.Length, Static("S7p"), Do("DecodeWString", Stream(hex), n + 1));
        }
        foreach (var b in new[] { new byte[0], new byte[] { 1 }, new byte[] { 1, 2, 3, 255, 0 } })
        {
            Program.Run("s7p", "encOctets-" + b.Length, Static("S7p"), Do("EncodeOctets", W(), b));
            Program.Run("s7p", "encOctetsNull", Static("S7p"), Do("EncodeOctets", W(), null));
            Program.Run("s7p", "decOctets-" + b.Length, Static("S7p"), Do("DecodeOctets", Stream(b), b.Length), Do("DecodeOctets", Stream(b), b.Length + 1), Do("DecodeOctets", Stream(b), 0), Do("DecodeOctets", Stream(b), -1));
        }
        foreach (var (ver, len) in new[] { (0, 0), (1, 5), (2, 0xffff), (3, 0x1234), (255, 1) })
            Program.Run("s7p", "header-" + ver, Static("S7p"), Do("EncodeHeader", W(), ver, len));
        foreach (var h in new[] { "7201001a", "72020000", "720302", "", "ff0201ff0000" })
            Program.Run("s7p", "decHeader-" + h, Static("S7p"), Do("DecodeHeader", Stream(h)));
        Program.Run("s7p", "objQualifier", Static("S7p"), Do("EncodeObjectQualifier", W()));
    }

    static void GenUtils()
    {
        var rnd = new Random(77);
        foreach (int len in new[] { 0, 1, 3, 4, 8, 16, 17, 33, 40 })
        {
            var b = new byte[len]; rnd.NextBytes(b);
            Program.Run("utils", "hexdump-" + len, Static("Utils"), Do("HexDump", b), Do("HexDump", b, 8), Do("HexDump", b, 5));
        }
        var arr = new byte[] { 0x01, 0x02, 0x83, 0xff, 0x7f, 0x80, 0x00, 0x40, 0x49, 0x0f, 0xdb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18 };
        foreach (var m in new[] { "GetUInt8", "GetUInt16LE", "GetUInt16", "GetInt16", "GetUInt32LE", "GetUInt32", "GetInt32", "GetFloat", "GetDouble" })
            for (uint pos = 0; pos < 6; pos++)
                Program.Run("utils", m + "-" + pos, Static("Utils"), Do(m, arr, pos));
        Program.Run("utils", "GetUtfString", Static("Utils"), Do("GetUtfString", Encoding.UTF8.GetBytes("héllo 日本"), 0u, 6u), Do("GetUtfString", Encoding.UTF8.GetBytes("héllo"), 1u, 3u));
        foreach (var ts in new ulong[] { 0, 1, 1000, 1700000000000000000UL, 1700000000123456789UL, 0x7fffffffffffffffUL })
            Program.Run("utils", "dtFromTimestamp-" + ts, Static("Utils"), Do("DtFromValueTimestamp", ts));
    }
}
