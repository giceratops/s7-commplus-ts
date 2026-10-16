using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    static byte[] ElemBytes(Random rnd, int offsetType, int bodyLen, uint lid)
    {
        var ms = new MemoryStream();
        S7p.EncodeUInt32(ms, 0); ms.Position = 0; ms.SetLength(0);
        void LE32(uint v) { ms.WriteByte((byte)v); ms.WriteByte((byte)(v >> 8)); ms.WriteByte((byte)(v >> 16)); ms.WriteByte((byte)(v >> 24)); }
        LE32(lid); LE32((uint)rnd.Next());
        ms.WriteByte((byte)rnd.Next(0, 256));
        ushort attr = (ushort)((offsetType << 12) | (rnd.Next(0, 0x1000)));
        S7p.EncodeUInt16(ms, attr);
        ms.WriteByte((byte)rnd.Next(0, 256));
        var body = new byte[bodyLen]; rnd.NextBytes(body);
        ms.Write(body, 0, body.Length);
        return ms.ToArray();
    }

    static void GenObjects()
    {
        // PObject serialize/deserialize
        for (int v = 0; v < 3; v++)
        {
            var vec = Program.Run("pobject", "demo" + v, DemoObject(v), SER, STR, DUMP);
            var hex = (string)vec["expect"][0]["hex"];
            Program.Run("pobject-dec", "demo" + v, Static("S7p"), Do("DecodeObject", Stream(hex)), Do("DecodeObject", Stream(hex), true), Do("DecodeObjectList", Stream(hex)), Do("DecodeObjectList", Stream(hex + hex)));
            Program.Run("pobject-dec", "demo" + v + "-trunc", Static("S7p"), Do("DecodeObject", Stream(hex.Substring(0, hex.Length - 2))), Do("DecodeObjectList", Stream(hex.Substring(0, hex.Length - 2))));
        }
        // PObject accessors
        Program.Run("pobject", "accessors", DemoObject(2), Do("GetObjectByClassId", 2u, 1u), Do("GetObjectByClassId", 99u, 1u), Do("GetObjectsByClassId", 3u), Do("GetObjects"), Do("GetAttribute", 0x7fffu), Do("GetAttribute", 5u), Do("AddAttribute", 0x7fffu, New("ValueBool", A(true, 0))), Do("AddObject", New("PObject", A(1u, 2u, 3u))));
        // objects with varname/vartype lists
        var rnd = new Random(4242);
        // varname list: blocklen, then (len, name, 0)*, blocklen 0
        byte[] NameBlock(string[] names)
        {
            var inner = new MemoryStream();
            foreach (var n in names) { var nb = Encoding.UTF8.GetBytes(n); inner.WriteByte((byte)nb.Length); inner.Write(nb, 0, nb.Length); inner.WriteByte(0); }
            var o = new MemoryStream(); S7p.EncodeUInt16(o, (ushort)inner.Length); o.Write(inner.ToArray(), 0, (int)inner.Length); return o.ToArray();
        }
        var vn = Cat(NameBlock(new[] { "Tag1", "Hällo", "x" }), Bytes(0, 0));
        Program.Run("varname", "list", New("PVarnameList"), Do("Deserialize", Stream(vn)), DUMP, STR);
        var vn2 = Cat(NameBlock(new[] { "A", "B" }), NameBlock(new[] { "C" }), Bytes(0, 0));
        Program.Run("varname", "list2", New("PVarnameList"), Do("Deserialize", Stream(vn2)), DUMP, STR);
        Program.Run("varname", "empty", New("PVarnameList"), Do("Deserialize", Stream(Bytes(0, 0))), DUMP, STR);
        // vartype elements
        for (int ot = 0; ot < 16; ot++)
            for (int k = 0; k < 3; k++)
            {
                var eb = ElemBytes(rnd, ot, 90, (uint)(k + 1));
                Program.Run("vartype-elem", "ot" + ot + "-" + k, New("PVartypeListElement"), Do("Deserialize", Stream(eb)), DUMP, STR);
                Program.Run("vartype-elem", "ot" + ot + "-" + k + "-short", New("PVartypeListElement"), Do("Deserialize", Stream(eb.Take(30).ToArray())), DUMP);
                // accessors
                Program.Run("vartype-elem", "ot" + ot + "-" + k + "-acc", New("PVartypeListElement"), Do("Deserialize", Stream(eb)), Do("GetAttributeSection"), Do("GetAttributeBitoffset"), Do("GetAttributeFlagHmiVisible"), Do("GetAttributeFlagHmiAccessible"), Do("GetAttributeFlagOptimizedAccess"), Do("GetAttributeFlagHmiReadonly"), Do("GetBitoffsetinfoFlagRetain"), Do("GetBitoffsetinfoFlagClassic"), Do("GetBitoffsetinfoNonoptimizedBitoffset"), Do("GetBitoffsetinfoOptimizedBitoffset"));
            }
        // offset info types directly
        foreach (var (cls, ot) in new[] { ("POffsetInfoType_Std", 8), ("POffsetInfoType_Std", 1) })
            for (int k = 0; k < 4; k++) { var body = new byte[60]; rnd.NextBytes(body); Program.Run("offsetinfo", cls + ot + "-" + k, Static("POffsetInfoType_Std"), Do("Deserialize", Stream(body), ot)); }
        // vartype list assembled from elements
        foreach (var (n, sizes) in new[] { ("1", new[] { 8 }), ("3", new[] { 8, 9, 10 }), ("mix", new[] { 1, 3, 5, 12, 15 }) })
        {
            var ms = new MemoryStream();
            var elems = new List<byte[]>();
            int idx = 0;
            foreach (var ot in sizes)
            {
                var eb = ElemBytes(rnd, ot, 90, (uint)(++idx));
                // determine how many bytes C# consumes
                var tmp = new PVartypeListElement();
                int used = tmp.Deserialize(new MemoryStream(eb));
                elems.Add(eb.Take(used).ToArray());
            }
            var inner = new MemoryStream();
            inner.Write(new byte[] { 0x2a, 0, 0, 0 }, 0, 4); // FirstId LE
            foreach (var e in elems) inner.Write(e, 0, e.Length);
            S7p.EncodeUInt16(ms, (ushort)inner.Length);
            ms.Write(inner.ToArray(), 0, (int)inner.Length);
            S7p.EncodeUInt16(ms, 0);
            var full = ms.ToArray();
            Program.Run("vartype-list", n, New("PVartypeList"), Do("Deserialize", Stream(full)), DUMP, STR);
            // second block
            var ms2 = new MemoryStream(); ms2.Write(full, 0, full.Length - 2);
            var inner2 = new MemoryStream(); inner2.Write(elems[0], 0, elems[0].Length);
            S7p.EncodeUInt16(ms2, (ushort)inner2.Length); ms2.Write(inner2.ToArray(), 0, (int)inner2.Length); S7p.EncodeUInt16(ms2, 0);
            Program.Run("vartype-list", n + "-2blocks", New("PVartypeList"), Do("Deserialize", Stream(ms2.ToArray())), DUMP);
            // as part of an object stream: StartOfObject ... VartypeList, VarnameList, Terminating
            var objbytes = Cat(Bytes(ElementID.StartOfObject), Enc(s => S7p.EncodeUInt32(s, 5)), Enc(s => S7p.EncodeUInt32Vlq(s, 6)), Enc(s => S7p.EncodeUInt32Vlq(s, 0)), Enc(s => S7p.EncodeUInt32Vlq(s, 0)),
                Bytes(ElementID.VartypeList), full, Bytes(ElementID.VarnameList), vn, Bytes(ElementID.TerminatingObject));
            Program.Run("pobject-dec", "withlists-" + n, Static("S7p"), Do("DecodeObject", Stream(objbytes)));
            Program.Run("pobject-dec", "withlists-" + n + "-x", Static("S7p"), Do("DecodeObject", Stream(Cat(Bytes(ElementID.StartOfObject), Enc(s => S7p.EncodeUInt32(s, 5)), Enc(s => S7p.EncodeUInt32Vlq(s, 6)), Enc(s => S7p.EncodeUInt32Vlq(s, 0)), Enc(s => S7p.EncodeUInt32Vlq(s, 0)), Bytes(ElementID.StartOfTagDescription), Bytes(ElementID.TerminatingTagDescription), Bytes(0x55)))));
        }
    }
}
