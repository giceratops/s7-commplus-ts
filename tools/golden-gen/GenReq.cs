using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    static JsonObject IA(string s) => New("ItemAddress", A(s));
    static JsonObject IA(uint area, uint sub, params uint[] lids) => New("ItemAddress", A(area, sub), Set(("LID", lids)));

    static JsonObject DemoObject(int variant)
    {
        switch (variant)
        {
            case 0: return New("PObject", A(0u, 0u, 0u));
            case 1:
                return New("PObject", A(0x80c3c901u, 287u, 0u), null, A(
                    Do("AddAttribute", 1u, New("ValueDInt", A(-5, 0))),
                    Do("AddAttribute", 2u, New("ValueWString", A("héllo", 0))),
                    Do("AddRelation", 5u, 0xdeadbeefu)));
            default:
                return New("PObject", A(0x11u, 0x12u, 0x13u), Set(("ClassFlags", 0x80u)), A(
                    Do("AddAttribute", 0x7fffu, New("ValueUDInt", A(77u, 0))),
                    Do("AddObject", New("PObject", A(1u, 2u, 3u), null, A(Do("AddAttribute", 9u, New("ValueBool", A(true, 0)))))),
                    Do("AddObject", New("PObject", A(1u, 3u, 4u))),
                    Do("AddRelation", 1u, 2u), Do("AddRelation", 0x4000u, 0u)));
        }
    }

    static readonly (uint sess, ushort seq, uint iid)[] COMBOS = {
        (0, 0, 0), (0x12345678, 1, 1), (0xffffffff, 0xffff, 0xffffffff), (0x00000300, 0x1234, 0x80), (7, 300, 0x3fff), (0x8a0e0001, 65535, 0x4000),
    };

    static void GenRequests()
    {
        foreach (var pv in new[] { 1, 2, 3 })
        foreach (var (sess, seq, iid) in COMBOS)
        foreach (var withIid in new[] { true, false })
        {
            string tag = pv + "-" + sess.ToString("x") + "-" + seq + "-" + iid + (withIid ? "-iid" : "-noiid");
            JsonObject Base(params (string, object)[] extra)
            {
                var kv = new List<(string, object)> { ("SessionId", sess), ("SequenceNumber", seq), ("IntegrityId", iid), ("WithIntegrityId", withIid) };
                kv.AddRange(extra);
                return Set(kv.ToArray());
            }
            // Explore
            Program.Run("req", "Explore-" + tag, New("ExploreRequest", A(pv), Base(("ExploreId", 0x8a0e0001u), ("ExploreRequestId", 0x130u), ("ExploreChildsRecursive", 1), ("ExploreParents", 0), ("AddressList", new uint[] { 1, 0x80, 0x4000, 0xffffffff }))), SER, STR);
            Program.Run("req", "ExploreFilter-" + tag, New("ExploreRequest", A(pv), Base(("ExploreId", 0xffffffffu), ("ExploreRequestId", 0u), ("ExploreChildsRecursive", 0), ("ExploreParents", 1))), SER, STR);
            // Delete
            Program.Run("req", "Delete-" + tag, New("DeleteObjectRequest", A(pv), Base(("DeleteObjectId", 0xdeadbeefu))), SER, STR);
            // GetMulti
            Program.Run("req", "GetMulti-" + tag, New("GetMultiVariablesRequest", A(pv), Base(("LinkId", 0u))), SER, STR);
            Program.Run("req", "GetMulti2-" + tag, New("GetMultiVariablesRequest", A(pv), Base(("LinkId", 5u), ("AddressList", new[] { IA("8A0E000F.9"), IA(0x52, 0xa, 1, 2, 0x300000), IA("52.A") }))), SER, STR);
            // GetVarSubstreamed
            Program.Run("req", "GetVarSub-" + tag, New("GetVarSubstreamedRequest", A(pv), Base(("InObjectId", 0x12345678u), ("Address", 0x8001))), SER, STR);
            // InitSsl
            Program.Run("req", "InitSsl-" + tag, New("InitSslRequest", A(pv, seq, sess), Set(("IntegrityId", iid), ("WithIntegrityId", withIid))), SER, STR);
            // SetVariable
            Program.Run("req", "SetVar-" + tag, New("SetVariableRequest", A(pv), Base(("InObjectId", 0x8a0e0001u), ("Address", 0x2f2u), ("Value", New("ValueWString", A("héllo", 0))))), SER, STR);
            // SetMulti: plain variables
            Program.Run("req", "SetMultiVar-" + tag, New("SetMultiVariablesRequest", A(pv), Base(("InObjectId", 0u), ("AddressListVar", new[] { IA("8A0E000F.9"), IA("52.A.5") }), ("ValueList", new[] { New("ValueDInt", A(-1, 0)), New("ValueBoolArray", A(new[] { true, false }, 0x10)) }))), SER, STR);
            // SetMulti: object
            Program.Run("req", "SetMultiObj-" + tag, New("SetMultiVariablesRequest", A(pv), Base(("InObjectId", 0x1234u), ("AddressList", new uint[] { 0x1u, 0x2u, 0x300u }), ("ValueList", new[] { New("ValueUDInt", A(5u, 0)), New("ValueLInt", A(-7L, 0)) }))), SER, STR);
            Program.Run("req", "SetMultiEmpty-" + tag, New("SetMultiVariablesRequest", A(pv), Base()), SER, STR);
            // CreateObject
            Program.Run("req", "CreateNull-" + tag, New("CreateObjectRequest", A(pv, seq, withIid), Set(("SessionId", sess), ("IntegrityId", iid)), A(Do("SetNullServerSessionData"))), SER, STR);
            for (int ov = 0; ov < 3; ov++)
                Program.Run("req", "Create" + ov + "-" + tag, New("CreateObjectRequest", A(pv, seq, withIid), Set(("SessionId", sess), ("IntegrityId", iid)), A(Do("SetRequestIdValue", 0x11u, New("ValueUDInt", A(0u, 0))), Do("SetRequestObject", DemoObject(ov)))), SER, STR);
        }
        // Explore with filter struct
        var filter = New("ValueStruct", A(0x8a0e0001u, 0), null, A(Do("AddStructElement", 1u, New("ValueUDInt", A(5u, 0)))));
        foreach (var f in new[] { filter, New("ValueStruct", A(0x90000001u, 0), Set(("PackedStructInterfaceTimestamp", 5UL)), A(Do("AddStructElement", 0x90000001u, New("ValueByteArray", A(new byte[] { 1, 2 }, 0x10))))) })
            Program.Run("req", "ExploreFilter-" + f["args"][0].ToJsonString(), New("ExploreRequest", A(3), Set(("SessionId", 5u), ("SequenceNumber", 6), ("IntegrityId", 7u), ("ExploreId", 5u), ("FilterData", f), ("AddressList", new uint[] { 1, 2 }))), SER, STR);
        // SetMulti session setup
        Program.Run("req", "SetMultiSessionSetup", New("SetMultiVariablesRequest", A(2), Set(("SequenceNumber", 3)), A(Do("SetSessionSetupData", 0x12345u, New("ValueStruct", A(0x1u, 0), null, A(Do("AddStructElement", 5u, New("ValueUDInt", A(5u, 0)))))))), SER, STR);
        // GetVarSubstreamed transportflags
        Program.Run("req", "GetVarSubFlags", New("GetVarSubstreamedRequest", A(2), Set(("TransportFlags", 0x36), ("InObjectId", 1u), ("Address", 0xffff))), SER, STR);
        Program.Run("req", "SetVarFlags", New("SetVariableRequest", A(2), Set(("TransportFlags", 0x36), ("InObjectId", 1u), ("Address", 5u), ("Value", New("ValueNull")))), SER, STR);

        // ItemAddress
        foreach (var s in new[] { "8A0E0001.A", "8A0E000F.9", "52.A", "50.A.1.2", "8A0E0000.1.2.3", "52", "1.2", "FFFFFFFF.FFFFFFFF", "5", "0.0", "50", "51.10", "52.10", "ab.cd", "8a0dffff.1" })
            Program.Run("itemaddress", "str-" + s, New("ItemAddress", A(s)), SER, STR, Do("GetAccessString"), Do("GetNumberOfFields"), DUMP);
        foreach (var s in new[] { "", "xyz", "1.zz" })
            Program.Run("itemaddress", "bad-" + s, New("ItemAddress", A(s)), DUMP);
        Program.Run("itemaddress", "default", New("ItemAddress"), SER, STR, Do("GetAccessString"), Do("GetNumberOfFields"), DUMP);
        Program.Run("itemaddress", "ctor2", New("ItemAddress", A(0x8a0e0001u, 0x45u), Set(("LID", new uint[] { 1, 2, 3 }))), SER, STR, Do("GetAccessString"), Do("GetNumberOfFields"), DUMP);
        foreach (uint nb in new uint[] { 0, 1, 2, 65535, 65536, 70000 })
            Program.Run("itemaddress", "setdb-" + nb, New("ItemAddress"), Do("SetAccessAreaToDatablock", nb), DUMP, Do("GetAccessString"));
    }
}
