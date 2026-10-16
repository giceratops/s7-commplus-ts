// Harness that runs the ORIGINAL C# S7CommPlusDriver (network layer included, linked unmodified via CsNetDriver.csproj)
// against the in-process mock PLC of the TypeScript port. Driven by tools/c-sharp-net-driver/record.ts:
//   CsNetDriver <host> <port> <scenario> [password] [username]
// Protocol with the orchestrator (stdout/stdin; the driver's own console output is captured separately):
//   "@@CMD <json>"     -> ask the orchestrator to change something in the mock PLC, then wait for one line on stdin
//   "@@RESULT <json>"  -> final result: { steps: [...], log: "..." }
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using S7CommPlusDriver.Alarming;

static class Program
{
    static TextWriter proto;
    static StringBuilder captured = new StringBuilder();
    static List<Dictionary<string, object>> steps = new List<Dictionary<string, object>>();
    static string host, password = "", username = "";
    static int port;

    // ---- libssl mapping: the driver P/Invokes libssl-3-x64.dll / libcrypto-3-x64.dll ----
    static IntPtr Resolve(string name, Assembly asm, DllImportSearchPath? path)
    {
        string target = null;
        if (name.StartsWith("libssl-3")) target = "libssl.so.3";
        else if (name.StartsWith("libcrypto-3")) target = "libcrypto.so.3";
        if (target == null) return IntPtr.Zero;
        return NativeLibrary.Load(target);
    }

    class Tee : TextWriter
    {
        public override Encoding Encoding => Encoding.UTF8;
        public override void Write(char c) { lock (captured) captured.Append(c); }
        public override void Write(string s) { lock (captured) captured.Append(s); }
    }

    static void Step(string name, params object[] kv)
    {
        var d = new Dictionary<string, object> { ["step"] = name };
        for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        steps.Add(d);
    }

    static void Cmd(object cmd)
    {
        proto.WriteLine("@@CMD " + JsonSerializer.Serialize(cmd));
        proto.Flush();
        Console.In.ReadLine();
    }

    static string Sha256Hex(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    static string Describe(object v)
    {
        if (v == null) return "null";
        return v.GetType().Name + " " + v.ToString();
    }

    static T Priv<T>(object o, string field)
    {
        var f = o.GetType().GetField(field, BindingFlags.NonPublic | BindingFlags.Instance);
        return (T)f.GetValue(o);
    }

    static S7CommPlusConnection NewConn() => new S7CommPlusConnection();

    static S7CommPlusConnection Connect(string stepName = "connect")
    {
        var conn = NewConn();
        int res = conn.Connect(host, password, username, 3000);
        Step(stepName, "res", res);
        return res == 0 ? conn : null;
    }

    static string TagLine(PlcTag t) => t.Name + " | q=" + t.Quality + " | " + t.ToString() + " | re=" + t.LastReadError + " | we=" + t.LastWriteError;

    static PlcTag Tag(S7CommPlusConnection c, string sym)
    {
        try
        {
            var t = c.getPlcTagBySymbol(sym);
            return t;
        }
        catch (Exception e)
        {
            Step("tag-exception:" + sym, "message", e.Message);
            return null;
        }
    }

    static void Disc(S7CommPlusConnection c)
    {
        c.Disconnect();
        Step("disconnect", "sessionId", (uint)Priv<UInt32>(c, "m_SessionId"));
    }

    static void ScConnect()
    {
        var c = Connect();
        if (c == null) return;
        var cr = Priv<CommRessources>(c, "m_CommRessources");
        Step("session", "sessionId", Priv<UInt32>(c, "m_SessionId"), "sessionId2", c.SessionId2,
            "tagsRead", cr.TagsPerReadRequestMax, "tagsWrite", cr.TagsPerWriteRequestMax, "subsMax", cr.PlcSubscriptionsMax,
            "attrMax", cr.PlcAttributesMax, "subMemMax", cr.SubscriptionMemoryMax);
        Disc(c);
    }

    static void ScLegit()
    {
        var c = Connect();
        if (c == null) return;
        var items = new List<ItemAddress> { new ItemAddress("8A0E0002.A") };
        int res = c.ReadValues(items, out var values, out var errors);
        Step("read-after-login", "res", res, "values", values.Select(Describe).ToList(), "errors", errors.Select(e => e.ToString()).ToList());
        Disc(c);
    }

    static void ScBrowse()
    {
        var c = Connect();
        if (c == null) return;
        int res = c.GetListOfDatablocks(out var dbs);
        Step("datablocks", "res", res, "dbs", dbs.Select(d => d.db_name + "|" + d.db_number + "|" + d.db_block_relid + "|" + d.db_block_ti_relid).ToList());
        res = c.Browse(out var vars);
        var lines = vars.Select(v => string.Join("|", v.Name, v.AccessSequence, v.Softdatatype, v.OptAddress, v.OptBitoffset, v.NonOptAddress, v.NonOptBitoffset)).ToList();
        Step("browse", "res", res, "count", lines.Count, "sha256", Sha256Hex(string.Join("\n", lines)), "head", lines.Take(25).ToList(), "tail", lines.Skip(Math.Max(0, lines.Count - 3)).ToList());
        Disc(c);
    }

    static readonly string[] SymbolCases = {
        "TestDB.counter", "\"TestDB\".counter", "TestDB.samples[2]", "TestDB.samples", "TestDB.motor.speed", "Other.value",
        "TestDB.doesNotExist", "NoSuchDb.x", "TestDB.samples[9]", "TestDB.motor.running", "TestDB.bytes",
    };

    static void ScSymbols()
    {
        var c = Connect();
        if (c == null) return;
        foreach (var s in SymbolCases)
        {
            var t = Tag(c, s);
            Step("symbol:" + s, "tag", t == null ? "null" : t.GetType().Name + " " + t.Address.GetAccessString() + " " + t.Datatype);
        }
        Disc(c);
    }

    static readonly string[] ReadNames = {
        "TestDB.flag", "TestDB.counter", "TestDB.bigNumber", "TestDB.temperature", "TestDB.name", "TestDB.samples[1]",
        "TestDB.samples", "TestDB.motor.speed", "TestDB.motor.running", "TestDB.motor.mode", "TestDB.word", "TestDB.dword",
        "TestDB.lreal", "TestDB.lint", "TestDB.usint", "TestDB.udint", "Other.value",
    };

    static void ScReadWrite()
    {
        var c = Connect();
        if (c == null) return;
        var tags = new List<PlcTag>();
        foreach (var n in ReadNames) tags.Add(Tag(c, n));
        int res = c.ReadTags(tags);
        Step("read-all", "res", res, "tags", tags.Select(TagLine).ToList());

        var flag = (PlcTagBool)Tag(c, "TestDB.flag");
        var counter = (PlcTagInt)Tag(c, "TestDB.counter");
        var big = (PlcTagDInt)Tag(c, "TestDB.bigNumber");
        var temp = (PlcTagReal)Tag(c, "TestDB.temperature");
        var name = (PlcTagString)Tag(c, "TestDB.name");
        var smp = (PlcTagIntArray)Tag(c, "TestDB.samples");
        var speed = (PlcTagLReal)Tag(c, "TestDB.motor.speed");
        var word = (PlcTagWord)Tag(c, "TestDB.word");
        var dword = (PlcTagDWord)Tag(c, "TestDB.dword");
        var lint = (PlcTagLInt)Tag(c, "TestDB.lint");
        var usint = (PlcTagUSInt)Tag(c, "TestDB.usint");
        var udint = (PlcTagUDInt)Tag(c, "TestDB.udint");
        var mode = (PlcTagByte)Tag(c, "TestDB.motor.mode");
        flag.Value = false;
        counter.Value = 32767;
        big.Value = -2147483648;
        temp.Value = -273.15f;
        name.Value = "Grüße vom Test";
        smp.Value = new short[] { -1, 0, 1, 32767 };
        speed.Value = 1e300;
        word.Value = 0x1234;
        dword.Value = 0xffffffff;
        lint.Value = 9223372036854775807L;
        usint.Value = 255;
        udint.Value = 123;
        mode.Value = 0xaa;
        var all = new List<PlcTag> { flag, counter, big, temp, name, smp, speed, word, dword, lint, usint, udint, mode };
        res = c.WriteTags(all);
        Step("write-all", "res", res, "errors", all.Select(t => t.Name + "=" + t.LastWriteError).ToList());
        var fresh = new List<PlcTag>();
        foreach (var t in all) fresh.Add(Tag(c, t.Name));
        res = c.ReadTags(fresh);
        Step("readback", "res", res, "tags", fresh.Select(TagLine).ToList());

        // String[20] + 2000 byte array (fragmented request)
        var st = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
        st.Value = "twenty chars string!";
        var bytes = (PlcTagByteArray)Tag(c, "TestDB.bytes");
        var bv = new byte[2000];
        for (int i = 0; i < 2000; i++) bv[i] = (byte)((i * 13 + 5) & 0xff);
        bytes.Value = bv;
        res = c.WriteTags(new List<PlcTag> { st, bytes });
        Step("write-big", "res", res, "stErr", st.LastWriteError.ToString(), "bytesErr", bytes.LastWriteError.ToString());
        var st2 = new PlcTagString("short", new ItemAddress("8A0E0001.17"), Softdatatype.S7COMMP_SOFTDATATYPE_STRING, 20);
        var b2 = (PlcTagByteArray)Tag(c, "TestDB.bytes");
        res = c.ReadTags(new List<PlcTag> { st2, b2 });
        Step("read-big", "res", res, "str", st2.Value, "bytesSha", Sha256Hex(Convert.ToBase64String(b2.Value)), "bytesEqual", b2.Value.SequenceEqual(bv));

        // per-item errors
        var wrong = new PlcTagDInt("wrong", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_DINT);
        wrong.Value = 5;
        var good = (PlcTagInt)Tag(c, "TestDB.counter");
        good.Value = 77;
        res = c.WriteTags(new List<PlcTag> { wrong, good });
        Step("write-wrongtype", "res", res, "wrongErr", wrong.LastWriteError.ToString(), "goodErr", good.LastWriteError.ToString());
        var missing = new PlcTagInt("missing", new ItemAddress("8A0E0001.99"), Softdatatype.S7COMMP_SOFTDATATYPE_INT);
        var ok = Tag(c, "TestDB.counter");
        res = c.ReadTags(new List<PlcTag> { missing, ok });
        Step("read-missing", "res", res, "tags", new List<PlcTag> { missing, ok }.Select(TagLine).ToList());
        var mism = new PlcTagReal("mism", new ItemAddress("8A0E0001.B"), Softdatatype.S7COMMP_SOFTDATATYPE_REAL);
        res = c.ReadTags(new List<PlcTag> { mism });
        Step("read-mismatch", "res", res, "tags", new List<PlcTag> { mism }.Select(TagLine).ToList());
        Disc(c);
    }

    static void ScLimits()
    {
        var c = Connect();
        if (c == null) return;
        var cr = Priv<CommRessources>(c, "m_CommRessources");
        Step("limits", "read", cr.TagsPerReadRequestMax, "write", cr.TagsPerWriteRequestMax);
        var addrs = new[] { "8A0E0001.A", "8A0E0001.B", "8A0E0001.C", "8A0E0001.D", "8A0E0001.99", "8A0E0001.11", "8A0E0002.A" }.Select(a => new ItemAddress(a)).ToList();
        int res = c.ReadValues(addrs, out var values, out var errors);
        Step("read", "res", res, "values", values.Select(Describe).ToList(), "errors", errors.Select(e => e.ToString()).ToList());
        var waddrs = new[] { "8A0E0001.B", "8A0E0001.C", "8A0E0001.99", "8A0E0001.11", "8A0E0001.A" }.Select(a => new ItemAddress(a)).ToList();
        var vals = new List<PValue> { new ValueInt(1), new ValueDInt(2), new ValueInt(3), new ValueInt(4), new ValueDInt(5) };
        res = c.WriteValues(waddrs, vals, out var werrors);
        Step("write", "res", res, "errors", werrors.Select(e => e.ToString()).ToList());
        Disc(c);
    }

    static void ScMisc()
    {
        var c = Connect();
        if (c == null) return;
        int res = c.GetCommentsXml(0x8a0e0001, out var line, out var db);
        Step("comments", "res", res, "line", line, "db", db);
        res = c.SetPlcOperatingState(3);
        Step("opstate", "res", res);
        Disc(c);
    }

    static void ScSubscription()
    {
        var c = Connect();
        if (c == null) return;
        var counter = (PlcTagInt)Tag(c, "TestDB.counter");
        var temp = (PlcTagReal)Tag(c, "TestDB.temperature");
        var arr = (PlcTagInt)Tag(c, "TestDB.samples[1]");
        var tags = new List<PlcTag> { counter, temp, arr };
        int res = c.SubscriptionCreate(tags, 100);
        Step("subscribe", "res", res);
        res = c.TestWaitForVariableChangeNotifications(1);
        Step("initial-notification", "res", res, "tags", tags.Select(TagLine).ToList());
        Cmd(new { op = "setValue", key = "8A0E0001.B", type = "int", value = 4711 });
        res = c.TestWaitForVariableChangeNotifications(1);
        Step("change-notification", "res", res, "tags", tags.Select(TagLine).ToList());
        for (int i = 0; i < 8; i++)
        {
            Cmd(new { op = "setValue", key = "8A0E0001.B", type = "int", value = 5000 + i });
            res = c.TestWaitForVariableChangeNotifications(1);
            Step("change-notification-" + i, "res", res, "counter", counter.ToString());
        }
        Cmd(new { op = "waitCredit" });
        res = c.SubscriptionDelete();
        Step("unsubscribe", "res", res);
        Disc(c);
    }

    static void ScAlarm()
    {
        var c = Connect();
        if (c == null) return;
        int res = c.AlarmSubscriptionCreate();
        Step("alarm-subscribe", "res", res);
        // The notification is pushed by the orchestrator while we wait.
        var t = new System.Threading.Thread(() => Cmd(new { op = "alarm" }));
        lock (captured) captured.Clear();
        t.Start();
        res = c.TestWaitForAlarmNotifications(3000, 1, 1031);
        t.Join();
        string log;
        lock (captured) log = captured.ToString();
        var interesting = log.Split('\n').Where(l => l.TrimStart().StartsWith("<") || l.Contains("AlarmText")).ToList();
        Step("alarm-notification", "res", res, "dai", interesting);
        res = c.AlarmSubscriptionDelete();
        Step("alarm-unsubscribe", "res", res);
        Disc(c);
    }


    // ---- alarms / comm resources (twins of the RUN entries in test/csharp-diff/scenarios.ts) ----

    static string Nl(string x) => x.Replace("\r\n", "\n").Replace("\n", "\\n");

    static List<string> AlarmLines(Dictionary<ulong, AlarmData> d) => d.Select(kv => kv.Key + "|" + Nl(kv.Value.ToString())).ToList();

    static List<string> CrLines(CommRessources cr) => Nl(cr.ToString()).Split("\\n").ToList();

    static void Guarded(string name, Func<object[]> fn)
    {
        try
        {
            var kv = fn();
            Step(name, kv);
        }
        catch (Exception)
        {
            Step(name, "threw", true);
        }
    }

    static Dictionary<ulong, AlarmData> ExploreStep(S7CommPlusConnection c, string name, int lang, Dictionary<ulong, AlarmData> d = null)
    {
        d = d ?? new Dictionary<ulong, AlarmData>();
        Guarded(name, () =>
        {
            int res = c.ExploreASAlarms(ref d, lang);
            return new object[] { "res", res, "count", d.Count, "alarms", AlarmLines(d) };
        });
        return d;
    }

    static void ActiveStep(S7CommPlusConnection c, string name, int lang)
    {
        Guarded(name, () =>
        {
            int res = c.GetActiveAlarms(out var list, lang);
            return new object[] { "res", res, "count", list.Count, "alarms", list.Select(a => a == null ? "null" : Nl(a.ToString())).ToList() };
        });
    }

    static void ReadAfter(S7CommPlusConnection c)
    {
        int res = c.ReadValues(new List<ItemAddress> { new ItemAddress("8A0E0002.A") }, out var values, out var errors);
        Step("read-after", "res", res, "values", values.Select(Describe).ToList(), "errors", errors.Select(e => e.ToString()).ToList());
    }

    static List<string> LogLines(string needle)
    {
        string log;
        lock (captured) log = captured.ToString();
        return log.Split('\n').Where(l => l.Contains(needle)).ToList();
    }

    static void ScAlarmsBrowse()
    {
        var c = Connect();
        if (c == null) return;
        var de = ExploreStep(c, "explore-de", 1031);
        ExploreStep(c, "explore-en", 1033);
        ExploreStep(c, "explore-fr", 1036);
        ExploreStep(c, "explore-unknown-language", 1040);
        ExploreStep(c, "explore-language-masked", 0x10000 + 1031);
        ExploreStep(c, "explore-twice", 1031, de);
        ReadAfter(c);
        Disc(c);
    }

    static void ScAlarmsActive()
    {
        var c = Connect();
        if (c == null) return;
        ActiveStep(c, "active-de", 1031);
        ActiveStep(c, "active-en", 1033);
        ActiveStep(c, "active-fr", 1036);
        ActiveStep(c, "active-unknown-language", 1040);
        Step("alarm-subscribe", "res", c.AlarmSubscriptionCreate());
        ActiveStep(c, "active-with-subscription", 1031);
        Step("alarm-unsubscribe", "res", c.AlarmSubscriptionDelete());
        Disc(c);
    }

    static void ScAlarmsActiveNone()
    {
        var c = Connect();
        if (c == null) return;
        ActiveStep(c, "active-de", 1031);
        Disc(c);
    }

    static void ScAlarmsOdd()
    {
        var c = Connect();
        if (c == null) return;
        lock (captured) captured.Clear();
        ExploreStep(c, "explore-de", 1031);
        Step("explore-log", "lines", LogLines("ExploreASAlarms()"));
        ActiveStep(c, "active-de", 1031);
        Disc(c);
    }

    static void ScAlarmsNotext()
    {
        var c = Connect();
        if (c == null) return;
        ActiveStep(c, "active-de", 1031);
        ReadAfter(c);
        Disc(c);
    }

    static void ScAlarmsErr()
    {
        var c = Connect();
        if (c == null) return;
        ExploreStep(c, "explore-1-asalarms", 1031);
        ExploreStep(c, "explore-2-program", 1031);
        ExploreStep(c, "explore-3-texts", 1031);
        ActiveStep(c, "active-1", 1031);
        ActiveStep(c, "active-2", 1031);
        ExploreStep(c, "explore-4-ok", 1031);
        Disc(c);
    }

    static void ScCommResources()
    {
        var c = Connect();
        if (c == null) return;
        var cr = Priv<CommRessources>(c, "m_CommRessources");
        Step("after-connect", "cr", CrLines(cr));
        int res = cr.ReadFree(c);
        Step("read-free", "res", res, "cr", CrLines(cr));
        res = cr.ReadMax(c);
        Step("read-max", "res", res, "cr", CrLines(cr));
        var t1 = (PlcTagInt)Tag(c, "TestDB.counter");
        var t2 = (PlcTagInt)Tag(c, "TestDB.samples[1]");
        Step("subscribe", "res", c.SubscriptionCreate(new List<PlcTag> { t1, t2 }, 100));
        Step("initial-notification", "res", c.TestWaitForVariableChangeNotifications(1));
        res = cr.ReadFree(c);
        Step("read-free-subscribed", "res", res, "cr", CrLines(cr));
        Step("unsubscribe", "res", c.SubscriptionDelete());
        res = cr.ReadFree(c);
        Step("read-free-unsubscribed", "res", res, "cr", CrLines(cr));
        Disc(c);
    }

    static void ScCommResourcesErr()
    {
        var c = Connect();
        if (c == null) return;
        var cr = Priv<CommRessources>(c, "m_CommRessources");
        int res = cr.ReadFree(c);
        Step("read-free", "res", res, "cr", CrLines(cr));
        Disc(c);
    }

    static void ScCommResourcesType()
    {
        var c = Connect();
        if (c == null) return;
        var cr = Priv<CommRessources>(c, "m_CommRessources");
        Guarded("read-free", () =>
        {
            int res = cr.ReadFree(c);
            return new object[] { "res", res, "cr", CrLines(cr) };
        });
        ReadAfter(c);
        Disc(c);
    }

    // second legitimation on the authenticated session through the private methods
    static void ScLegitTwice(bool legacy, bool wrong)
    {
        var c = Connect();
        if (c == null) return;
        string pw = wrong ? "wrong-2" : password;
        int res;
        if (legacy)
        {
            var m = typeof(S7CommPlusConnection).GetMethod("legitimateLegacy", BindingFlags.NonPublic | BindingFlags.Instance);
            res = (int)m.Invoke(c, new object[] { pw });
        }
        else
        {
            var m = typeof(S7CommPlusConnection).GetMethod("legitimateNew", BindingFlags.NonPublic | BindingFlags.Instance);
            res = (int)m.Invoke(c, new object[] { pw, username });
        }
        Step("legitimate-again", "res", res);
        if (res != 0) return;
        ReadAfter(c);
        Disc(c);
    }

    static int Main(string[] args)
    {
        // ToString() dumps of the driver (DateTime, float, ...) depend on the current culture; the port emulates the invariant one
        System.Globalization.CultureInfo.DefaultThreadCurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
        System.Globalization.CultureInfo.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
        proto = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(new Tee());
        NativeLibrary.SetDllImportResolver(typeof(OpenSsl.Native).Assembly, Resolve);
        host = args[0];
        port = int.Parse(args[1]);
        string scenario = args[2];
        if (args.Length > 3) password = args[3];
        if (args.Length > 4) username = args[4];

        // The port is a private static field of S7Client (ISOTCP = 102), read by the PLCPort field initialiser.
        typeof(S7Client).GetField("ISOTCP", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, port);

        try
        {
            // variants ("readwrite-fragmented", ...) only differ in the framing options of the mock PLC
            string baseName = scenario.StartsWith("err-") ? "legit-legacy" : scenario.StartsWith("readwrite") ? "readwrite" : scenario.StartsWith("browse") ? "browse" : scenario;
            switch (baseName)
            {
                case "connect": ScConnect(); break;
                case "legit-legacy": case "legit-new": case "legit-new-user": case "legit-unprotected": case "legit-denied-legacy": case "legit-denied-new": case "legit-none-protected": ScLegit(); break;
                case "browse": ScBrowse(); break;
                case "symbols": ScSymbols(); break;
                case "readwrite": ScReadWrite(); break;
                case "limits": ScLimits(); break;
                case "misc": ScMisc(); break;
                case "subscription": ScSubscription(); break;
                case "alarm": ScAlarm(); break;
                case "alarms-browse": ScAlarmsBrowse(); break;
                case "alarms-active": ScAlarmsActive(); break;
                case "alarms-active-none": ScAlarmsActiveNone(); break;
                case "alarms-odd": ScAlarmsOdd(); break;
                case "alarms-notext": ScAlarmsNotext(); break;
                case "alarms-err": ScAlarmsErr(); break;
                case "comm-resources": ScCommResources(); break;
                case "comm-resources-err": ScCommResourcesErr(); break;
                case "comm-resources-type": ScCommResourcesType(); break;
                case "legit-new-twice": case "legit-new-twice-denied": case "legit-new-user-twice": ScLegitTwice(false, baseName.EndsWith("denied")); break;
                case "legit-legacy-twice": case "legit-legacy-twice-denied": ScLegitTwice(true, baseName.EndsWith("denied")); break;
                default: throw new Exception("unknown scenario " + scenario);
            }
        }
        catch (Exception e)
        {
            Step("harness-exception", "type", e.GetType().Name, "message", e.ToString());
        }
        string log2;
        lock (captured) log2 = captured.ToString();
        proto.WriteLine("@@RESULT " + JsonSerializer.Serialize(new { steps, log = log2 }));
        proto.Flush();
        Environment.Exit(0);
        return 0;
    }
}
