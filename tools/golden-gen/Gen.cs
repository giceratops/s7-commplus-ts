using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    // ---------------- JSON building helpers ----------------
    public static JsonNode J(object o)
    {
        switch (o)
        {
            case null: return null;
            case JsonNode n: return n.DeepClone();
            case bool b: return b;
            case byte or sbyte or short or ushort or int or uint: return JsonValue.Create(Convert.ToInt64(o));
            case long l: return Big(l);
            case ulong ul: return Big(ul);
            case BigInteger bi: return Big(bi);
            case float f: return F((double)f);
            case double d: return F(d);
            case string s: return s;
            case byte[] ba when o.GetType() == typeof(byte[]): return new JsonObject { ["$hex"] = Hex(ba) };
            case DateTime dt: return new JsonObject { ["$dt"] = new JsonArray(dt.Year, dt.Month, dt.Day, dt.Hour, dt.Minute, dt.Second, dt.Millisecond) };
            case IEnumerable en:
                {
                    var a = new JsonArray();
                    foreach (var x in en) a.Add(J(x));
                    return a;
                }
        }
        throw new Exception("J: " + o.GetType());
    }
    public static JsonArray A(params object[] xs) { var a = new JsonArray(); foreach (var x in xs) a.Add(J(x)); return a; }
    public static JsonObject New(string cls, JsonArray args = null, JsonObject set = null, JsonArray doList = null)
    {
        var o = new JsonObject { ["new"] = cls, ["args"] = args ?? new JsonArray() };
        if (set != null) o["set"] = set;
        if (doList != null) o["do"] = doList;
        return o;
    }
    public static JsonObject Set(params (string, object)[] kv) { var o = new JsonObject(); foreach (var (k, v) in kv) o[k] = J(v); return o; }
    public static JsonObject Static(string cls) => new JsonObject { ["static"] = cls };
    public static JsonObject Stream(byte[] b) => new JsonObject { ["$stream"] = Hex(b) };
    public static JsonObject Stream(string hex) => new JsonObject { ["$stream"] = hex };
    public static JsonObject W() => new JsonObject { ["$w"] = 1 };
    public static JsonObject Map(params (object, object)[] kv)
    {
        var a = new JsonArray(); foreach (var (k, v) in kv) a.Add(new JsonArray(J(k), J(v)));
        return new JsonObject { ["$map"] = a };
    }
    public static JsonObject BlobEntry(uint id, byte[] v) => new JsonObject { ["$blobentry"] = new JsonArray(Big(id), v == null ? null : J(v)) };
    public static JsonArray Do(string name, params object[] args) { var a = new JsonArray(); a.Add(name); foreach (var x in args) a.Add(J(x)); return a; }
    static readonly JsonArray SER = Do("$serialize"), STR = Do("$toString"), DUMP = Do("$dump");

    static byte[] Bytes(params int[] b) => b.Select(x => (byte)x).ToArray();
    static byte[] Cat(params byte[][] bs) => bs.SelectMany(x => x).ToArray();

    // Serialize an object built from spec with C# to get bytes for composing canned PDUs
    public static byte[] SerializeSpec(JsonObject spec)
    {
        var inst = Build(spec);
        var ms = new MemoryStream();
        inst.GetType().GetMethod("Serialize", new[] { typeof(Stream) }).Invoke(inst, new object[] { ms });
        return ms.ToArray();
    }
    public static byte[] Enc(Func<Stream, int> f) { var ms = new MemoryStream(); f(ms); return ms.ToArray(); }

    public static JsonNode Constants()
    {
        var res = new JsonObject();
        foreach (var n in new[] { "Ids", "Datatype", "Opcode", "Functioncode", "ElementID", "ProtocolVersion", "Softdatatype" })
        {
            var t = FindType(n);
            var o = new JsonObject();
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Static))
            {
                var v = f.GetValue(null);
                if (v is bool || v is string) continue;
                try { o[f.Name] = JsonValue.Create(Convert.ToInt64(v)); } catch { }
            }
            res[n] = o;
        }
        return res;
    }

    public static void All()
    {
        GenS7p();
        GenUtils();
        GenPValue();
        GenRequests();
        GenObjects();
        GenResponses();
        GenTags();
        GenAlarms();
        GenBlob();
        GenFmt();
        GenFuzz();
    }
}
