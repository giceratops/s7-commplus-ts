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
    static byte[] Vlq(uint v) => Enc(s => S7p.EncodeUInt32Vlq(s, v));
    static byte[] Vlq64(ulong v) => Enc(s => S7p.EncodeUInt64Vlq(s, v));
    static byte[] U32b(uint v) => Enc(s => S7p.EncodeUInt32(s, v));
    static byte[] U16b(ushort v) => Enc(s => S7p.EncodeUInt16(s, v));
    static byte[] Ser(JsonObject spec) => SerializeSpec(spec);

    static byte[] RespHdr(int ver, int function, int seq, int tflags)
        => Cat(Bytes(ver, 0x32), U16b(0), U16b((ushort)function), U16b(0), U16b((ushort)seq), Bytes(tflags));
    // GetVar/SetVar style: version, opcode, function, seq, flags (no reserved for those? use same PDU format; Deserialize starts after header)

    static void GenResponses()
    {
        var objs = new[] { DemoObject(0), DemoObject(1), DemoObject(2) };
        var objb = objs.Select(Ser).ToArray();
        var pvDInt = Ser(New("ValueDInt", A(-5, 0)));
        var pvStr = Ser(New("ValueWString", A("héllo", 0)));
        var pvStruct = Ser(New("ValueStruct", A(0x8a0e0001u, 0), null, A(Do("AddStructElement", 1u, New("ValueDInt", A(-5, 0))))));
        var errObj = objb[1];

        ulong[] rets = { 0, 1, 0x80, 0x4000000000000000UL, 0x4000000000000001UL, 0x8000000000000000UL, 0xffffffffffffffffUL, 0x12345678 };
        void Resp(string cls, int fn, Func<ulong, bool, byte[]> body, bool withIid)
        {
            foreach (var pv in new[] { 2, 3 })
            foreach (var rv in rets)
            foreach (var wi in withIid ? new[] { true, false } : new[] { false })
            {
                var pdu = Cat(Bytes(pv, 0x32), U16b(0), U16b((ushort)fn), U16b(0), U16b(0x1234), Bytes(0x34), body(rv, wi));
                var doItem = withIid ? Do("DeserializeFromPdu", Stream(pdu), wi) : Do("DeserializeFromPdu", Stream(pdu));
                Program.Run("resp", cls + "-" + pv + "-" + rv.ToString("x") + "-" + wi, Static(cls), doItem);
                if (rv == 0 || rv == 0x4000000000000000UL)
                {
                    // truncated PDU
                    var tr = pdu.Take(pdu.Length - 1).ToArray();
                    var d2 = new JsonArray(); d2.Add("DeserializeFromPdu"); d2.Add(Stream(tr)); if (withIid) d2.Add(wi);
                    Program.Run("resp", cls + "-trunc-" + pv + "-" + rv.ToString("x") + "-" + wi, Static(cls), d2);
                }
            }
            // wrong opcode / function
            var bad1 = Cat(Bytes(2, 0x31), U16b(0), U16b((ushort)fn), U16b(0), U16b(1), Bytes(0x34), body(0, true));
            var bad2 = Cat(Bytes(2, 0x32), U16b(0), U16b((ushort)(fn ^ 0x100)), U16b(0), U16b(1), Bytes(0x34), body(0, true));
            foreach (var (n, p) in new[] { ("badop", bad1), ("badfn", bad2) })
            {
                var d = new JsonArray(); d.Add("DeserializeFromPdu"); d.Add(Stream(p)); if (withIid) d.Add(true);
                Program.Run("resp", cls + "-" + n, Static(cls), d);
            }
        }

        Resp("ExploreResponse", Functioncode.Explore, (rv, wi) => Cat(Vlq64(rv), U32b(0x8a0e0001), wi ? Vlq(0x1234) : new byte[0], objb[1], objb[2], new byte[] { 0 }), true);
        Resp("ExploreResponse", Functioncode.Explore, (rv, wi) => Cat(Vlq64(rv), U32b(7), wi ? Vlq(0x4000) : new byte[0], new byte[0]), true);
        Resp("CreateObjectResponse", Functioncode.CreateObject, (rv, wi) => Cat(Vlq64(rv), Bytes(2), Vlq(0x1234), Vlq(0x80000000), objb[2]), false);
        Resp("CreateObjectResponse", Functioncode.CreateObject, (rv, wi) => Cat(Vlq64(rv), Bytes(0), objb[0]), false);
        Resp("DeleteObjectResponse", Functioncode.DeleteObject, (rv, wi) => Cat(Vlq64(rv), U32b(0xdeadbeef), (rv & 0x4000000000000000UL) != 0 ? errObj : new byte[0], wi ? Vlq(0x300) : new byte[0]), true);
        Resp("GetMultiVariablesResponse", Functioncode.GetMultiVariables, (rv, wi) => Cat(Vlq64(rv), Vlq(1), pvDInt, Vlq(2), pvStr, Vlq(3), pvStruct, Vlq(0), Vlq(5), Vlq64(0x8104), Vlq(6), Vlq64(0xffffffffffffffffUL), Vlq(0), Vlq(0x7777)), false);
        Resp("GetMultiVariablesResponse", Functioncode.GetMultiVariables, (rv, wi) => Cat(Vlq64(rv), Vlq(0), Vlq(0), Vlq(1)), false);
        Resp("GetVarSubstreamedResponse", Functioncode.GetVarSubStreamed, (rv, wi) => Cat(Vlq64(rv), Bytes(0x11), pvStr, Vlq(0x99)), false);
        Resp("InitSslResponse", Functioncode.InitSsl, (rv, wi) => Cat(Vlq64(rv), (rv & 0x4000000000000000UL) != 0 ? errObj : new byte[0]), false);
        Resp("SetMultiVariablesResponse", Functioncode.SetMultiVariables, (rv, wi) => Cat(Vlq64(rv), Vlq(1), Vlq64(0x8104), Vlq(2), Vlq64(5), Vlq(0), Vlq(0x1234)), false);
        Resp("SetVariableResponse", Functioncode.SetVariable, (rv, wi) => Cat(Vlq64(rv), Vlq(0x1234)), false);

        // direct Deserialize on instances
        foreach (var pv in new[] { 2 })
        {
            var b = Cat(U16b(0x77), Bytes(0x34), Vlq64(0), U32b(5), Vlq(9), objb[1], new byte[] { 0 });
            Program.Run("resp", "ExploreResponse-direct", New("ExploreResponse", A(pv), Set(("WithIntegrityId", true))), Do("Deserialize", Stream(b)), DUMP, STR);
        }
        // SystemEvent
        var structVlq = Cat(Bytes(0, 0, 0, 0), Bytes(0, 0, Datatype.Struct), new byte[0]);
        byte[] SysData()
        {
            // struct with disableVlq encoding: [0][flags][0][datatype=struct] id(u32) {elements: key u32, value...} 0 u32
            var key = U32b(Ids.ReturnValue);
            var val = Cat(Bytes(0, 0, 0, Datatype.LInt), Enc(s => S7p.EncodeInt64(s, -5)));
            return Cat(Bytes(0, 0, 0, Datatype.Struct), U32b(0x8a0e0001), key, val, U32b(0));
        }
        byte[] SysDataOk()
        {
            var key = U32b(Ids.ReturnValue);
            var val = Cat(Bytes(0, 0, 0, Datatype.LInt), Enc(s => S7p.EncodeInt64(s, 5)));
            return Cat(Bytes(0, 0, 0, Datatype.Struct), U32b(0x8a0e0001), key, val, U32b(0));
        }
        var hdr = Cat(U32b(0), U32b(0x1234), U32b(0), U32b(0));
        // NOTE: peekType is read via DecodeUInt32 = bytes 00 00 00 ?? -> equals Datatype.Struct only if the 4 byte BE value == struct id
        foreach (var (n, payload) in new (string, byte[])[] {
            ("data-fatal", Cat(hdr, SysData())), ("data-ok", Cat(hdr, SysDataOk())), ("hdronly", hdr), ("msg", Cat(hdr, Encoding.UTF8.GetBytes("Hello message ä"))),
            ("short", hdr.Take(10).ToArray()), ("msg3", Cat(hdr, Bytes(65, 66, 67))), ("empty", new byte[0]),
            ("data-garbage", Cat(hdr, SysData().Take(20).ToArray())) })
        {
            var pdu = Cat(Bytes(ProtocolVersion.SystemEvent), payload);
            Program.Run("sysevent", n, Static("SystemEvent"), Do("DeserializeFromPdu", Stream(pdu)));
            Program.Run("sysevent", n + "-inst", New("SystemEvent", A(ProtocolVersion.SystemEvent)), Do("Deserialize", Stream(payload)), DUMP, Do("IsFatalError"), STR);
        }
        Program.Run("sysevent", "wrongversion", Static("SystemEvent"), Do("DeserializeFromPdu", Stream(Cat(Bytes(2), hdr))));

        // Notification
        byte[] Notif(int credit, uint seq, byte subscr, byte[] ts, byte[] items, byte[] p2)
            => Cat(U32b(0x11223344), U16b(1), U16b(2), U16b(3), Bytes(credit), Vlq(seq), subscr > 0 ? Bytes(subscr) : Cat(ts, Bytes(0x42)), items, p2);
        var tsBytes = Enc(s => S7p.EncodeUInt64(s, 1700000000123456UL));
        var itemsAll = Cat(Bytes(0x92), U32b(1), pvDInt, Bytes(0x9b), Vlq(0x4000), pvStr, Bytes(0x9c), U32b(7), Bytes(0x13), U32b(3), Bytes(0x03), U32b(4), Bytes(0));
        var itemsSimple = Cat(Bytes(0x92), U32b(1), pvDInt, Bytes(0));
        var p2 = Cat(U32b(0x44332211), U16b(9), Bytes(0x81), objb[1], objb[2]);
        var p2bad = Cat(U32b(0x44332211), U16b(9), Bytes(0x82), objb[1]);
        var cases = new List<(string, byte[])> {
            ("simple", Notif(1, 5, 7, null, itemsSimple, new byte[0])),
            ("all", Notif(255, 0x12345, 200, null, itemsAll, new byte[0])),
            ("ts", Notif(0, 1, 0, tsBytes, itemsSimple, new byte[0])),
            ("p2", Notif(1, 5, 7, null, itemsSimple, p2)),
            ("ts-p2", Notif(1, 5, 0, tsBytes, itemsAll, p2)),
            ("p2bad", Notif(1, 5, 7, null, itemsSimple, p2bad)),
            ("noitems", Notif(1, 5, 7, null, Bytes(0), new byte[0])),
            ("err83", Notif(1, 5, 7, null, Cat(Bytes(0x83)), new byte[0])),
            ("err81", Notif(1, 5, 7, null, Cat(Bytes(0x81)), new byte[0])),
            ("dupitem", Notif(1, 5, 7, null, Cat(Bytes(0x92), U32b(1), pvDInt, Bytes(0x92), U32b(1), pvDInt, Bytes(0)), new byte[0])),
            ("dupret", Notif(1, 5, 7, null, Cat(Bytes(0x13), U32b(1), Bytes(0x13), U32b(1), Bytes(0)), new byte[0])),
            ("struct", Notif(1, 5, 7, null, Cat(Bytes(0x9b), Vlq(1), pvStruct, Bytes(0)), new byte[0])),
            ("tsmax", Notif(1, 5, 0, Enc(s => S7p.EncodeUInt64(s, ulong.MaxValue >> 8)), itemsSimple, new byte[0])),
            ("ts0", Notif(1, 5, 0, Enc(s => S7p.EncodeUInt64(s, 0)), itemsSimple, new byte[0])),
        };
        foreach (var (n, body) in cases)
        {
            Program.Run("notif", n, Static("Notification"), Do("DeserializeFromPdu", Stream(Cat(Bytes(2, 0x33), body))));
            Program.Run("notif", n + "-wrongop", Static("Notification"), Do("DeserializeFromPdu", Stream(Cat(Bytes(2, 0x32), body))));
            Program.Run("notif", n + "-inst", New("Notification", A(3)), Do("Deserialize", Stream(body)), DUMP, STR);
            Program.Run("notif", n + "-trunc", Static("Notification"), Do("DeserializeFromPdu", Stream(Cat(Bytes(2, 0x33), body.Take(body.Length - 3).ToArray()))));
        }
    }
}
