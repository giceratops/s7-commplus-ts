// Reflection based interpreter: builds objects from JSON specs, calls members, dumps results.
// The same JSON specs are interpreted by test/golden.test.ts against the TypeScript port.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Text.Json.Nodes;
using S7CommPlusDriver;

static class Interp
{
    public static readonly Assembly Asm = typeof(PValue).Assembly;
    const BindingFlags ALL = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    public static Type FindType(string name)
    {
        var t = Asm.GetTypes().FirstOrDefault(x => x.Name == name && !x.IsNested);
        if (t == null) throw new Exception("type not found: " + name);
        return t;
    }

    public static string Hex(byte[] b) => b == null ? null : Convert.ToHexString(b).ToLowerInvariant();
    public static byte[] FromHex(string s) => Convert.FromHexString(s);

    // ---------- JSON helpers ----------
    public static JsonNode Big(BigInteger v) => new JsonObject { ["$big"] = v.ToString() };
    public static JsonNode F(double d)
    {
        if (double.IsNaN(d)) return new JsonObject { ["$f"] = "NaN" };
        if (double.IsPositiveInfinity(d)) return new JsonObject { ["$f"] = "Infinity" };
        if (double.IsNegativeInfinity(d)) return new JsonObject { ["$f"] = "-Infinity" };
        if (d == 0 && double.IsNegative(d)) return new JsonObject { ["$f"] = "-0" };
        return JsonValue.Create(d);
    }

    static BigInteger ToBig(JsonNode n)
    {
        if (n is JsonObject o)
        {
            if (o.ContainsKey("$big")) return BigInteger.Parse((string)o["$big"]);
        }
        if (n is JsonValue v)
        {
            var s = v.ToJsonString();
            return BigInteger.Parse(s);
        }
        throw new Exception("not an integer: " + n?.ToJsonString());
    }
    static double ToDbl(JsonNode n)
    {
        if (n is JsonObject o && o.ContainsKey("$f"))
        {
            switch ((string)o["$f"])
            {
                case "NaN": return double.NaN;
                case "Infinity": return double.PositiveInfinity;
                case "-Infinity": return double.NegativeInfinity;
                case "-0": return -0.0;
            }
        }
        if (n is JsonObject o2 && o2.ContainsKey("$big")) return (double)BigInteger.Parse((string)o2["$big"]);
        return n.GetValue<double>();
    }

    public static object ConvertTo(Type t, JsonNode n)
    {
        if (n == null) return null;
        if (n is JsonObject obj)
        {
            if (obj.ContainsKey("new") || obj.ContainsKey("static")) return Build(obj);
            if (obj.ContainsKey("$stream")) return new MemoryStream(FromHex((string)obj["$stream"]));
            if (obj.ContainsKey("$w")) return new MemoryStream();
            if (obj.ContainsKey("$pv")) return PValue.Deserialize(new MemoryStream(FromHex((string)obj["$pv"])));
            if (obj.ContainsKey("$hex")) return FromHex((string)obj["$hex"]);
            if (obj.ContainsKey("$dt"))
            {
                var a = obj["$dt"].AsArray().Select(x => x.GetValue<int>()).ToArray();
                return new DateTime(a[0], a[1], a[2], a[3], a[4], a[5], a.Length > 6 ? a[6] : 0);
            }
            if (obj.ContainsKey("$map"))
            {
                var gt = t.GetGenericArguments();
                var d = (IDictionary)Activator.CreateInstance(t);
                foreach (var kv in obj["$map"].AsArray())
                    d.Add(ConvertTo(gt[0], kv[0]), ConvertTo(gt[1], kv[1]));
                return d;
            }
            if (obj.ContainsKey("$blobentry"))
            {
                var e = new ValueBlobSparseArray.BlobEntry();
                object boxed = e;
                var ft = typeof(ValueBlobSparseArray.BlobEntry);
                ft.GetField("blobRootId").SetValue(boxed, (uint)ToBig(obj["$blobentry"][0]));
                ft.GetField("value").SetValue(boxed, obj["$blobentry"][1] == null ? null : FromHex((string)obj["$blobentry"][1]["$hex"]));
                return boxed;
            }
        }
        if (t == typeof(bool)) return n.GetValue<bool>();
        if (t == typeof(byte)) return (byte)ToBig(n);
        if (t == typeof(sbyte)) return (sbyte)ToBig(n);
        if (t == typeof(ushort)) return (ushort)ToBig(n);
        if (t == typeof(short)) return (short)ToBig(n);
        if (t == typeof(uint)) return (uint)ToBig(n);
        if (t == typeof(int)) return (int)ToBig(n);
        if (t == typeof(ulong)) return (ulong)ToBig(n);
        if (t == typeof(long)) return (long)ToBig(n);
        if (t == typeof(float)) return (float)ToDbl(n);
        if (t == typeof(double)) return ToDbl(n);
        if (t == typeof(string)) return (string)n;
        if (t == typeof(char)) return ((string)n)[0];
        if (t.IsEnum) return Enum.ToObject(t, (int)ToBig(n));
        if (t.IsArray)
        {
            var et = t.GetElementType();
            var arr = n.AsArray();
            var res = Array.CreateInstance(et, arr.Count);
            for (int i = 0; i < arr.Count; i++) res.SetValue(ConvertTo(et, arr[i]), i);
            return res;
        }
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(List<>))
        {
            var et = t.GetGenericArguments()[0];
            var l = (IList)Activator.CreateInstance(t);
            foreach (var x in n.AsArray()) l.Add(ConvertTo(et, x));
            return l;
        }
        if (t == typeof(object) && n is JsonValue) return n.ToJsonString();
        throw new Exception("cannot convert " + n.ToJsonString() + " to " + t);
    }

    public static object Build(JsonObject o)
    {
        if (o.ContainsKey("static")) return null; // static target marker
        var t = FindType((string)o["new"]);
        var args = o["args"]?.AsArray() ?? new JsonArray();
        object inst = null;
        Exception last = null;
        foreach (var c in t.GetConstructors(ALL & ~BindingFlags.Static).OrderBy(c => c.GetParameters().Length))
        {
            var ps = c.GetParameters();
            if (args.Count > ps.Length || ps.Skip(args.Count).Any(p => !p.HasDefaultValue)) continue;
            try
            {
                var av = new object[ps.Length];
                for (int i = 0; i < ps.Length; i++)
                    av[i] = i < args.Count ? ConvertTo(ps[i].ParameterType, args[i]) : ps[i].DefaultValue;
                inst = c.Invoke(av);
                break;
            }
            catch (Exception e) { last = e; }
        }
        if (inst == null)
        {
            if (t.GetConstructors(ALL).Length == 0 && args.Count == 0) inst = Activator.CreateInstance(t);
            else throw new Exception("no matching ctor for " + t.Name + " " + last?.Message);
        }
        if (o["set"] is JsonObject set)
            foreach (var kv in set) SetMember(inst, kv.Key, kv.Value);
        if (o["do"] is JsonArray calls)
            foreach (var c in calls) { var r = CallMethod(inst, t, c.AsArray()); if (r.ContainsKey("err")) throw new Exception("setup call failed: " + c.ToJsonString() + " " + r.ToJsonString()); }
        return inst;
    }

    static void SetMember(object inst, string name, JsonNode val)
    {
        var t = inst.GetType();
        var f = t.GetField(name, ALL);
        if (f != null) { f.SetValue(inst, ConvertTo(f.FieldType, val)); return; }
        var p = t.GetProperty(name, ALL);
        if (p != null) { p.SetValue(inst, ConvertTo(p.PropertyType, val)); return; }
        throw new Exception("no member " + name + " on " + t.Name);
    }

    // returns result object: JsonObject
    public static JsonObject CallMethod(object inst, Type t, JsonArray call)
    {
        string name = (string)call[0];
        var res = new JsonObject();
        try
        {
            if (name == "$serialize")
            {
                var ms = new MemoryStream();
                var m = inst.GetType().GetMethod("Serialize", new[] { typeof(Stream) });
                int ret = (int)m.Invoke(inst, new object[] { ms });
                res["ret"] = ret; res["hex"] = Hex(ms.ToArray());
                return res;
            }
            if (name == "$toString") { res["str"] = inst.ToString(); return res; }
            if (name == "$dump") { res["dump"] = Dump(inst, 0); return res; }
            bool isStatic = inst == null;
            var flags = ALL & ~(isStatic ? BindingFlags.Instance : BindingFlags.Static);
            var cands = t.GetMethods(flags).Where(m => m.Name == name).ToList();
            if (isStatic) cands.AddRange(t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Where(m => m.Name == name && !cands.Contains(m)));
            var args = call.Skip(1).ToList();
            MethodInfo mi = null;
            foreach (var c in cands)
            {
                var ps = c.GetParameters().Where(p => !p.ParameterType.IsByRef).ToArray();
                if (args.Count <= ps.Length && ps.Skip(args.Count).All(p => p.HasDefaultValue)) { mi = c; break; }
            }
            if (mi == null) throw new Exception("no method " + name + " on " + t.Name);
            var allps = mi.GetParameters();
            var av = new object[allps.Length];
            int ai = 0;
            for (int i = 0; i < allps.Length; i++)
            {
                if (allps[i].ParameterType.IsByRef) { av[i] = null; var et = allps[i].ParameterType.GetElementType(); if (et.IsValueType) av[i] = Activator.CreateInstance(et); continue; }
                av[i] = ai < args.Count ? ConvertTo(allps[i].ParameterType, args[ai]) : allps[i].DefaultValue;
                ai++;
            }
            object r = mi.Invoke(isStatic ? null : inst, av);
            if (mi.ReturnType != typeof(void)) res["ret"] = Dump(r, 0);
            var outs = new JsonArray(); var pos = new JsonArray();
            for (int i = 0; i < allps.Length; i++)
            {
                if (allps[i].ParameterType.IsByRef) outs.Add(Dump(av[i], 0));
                if (av[i] is MemoryStream ms)
                {
                    if (args.Count > 0 && args.Any(a => a is JsonObject ao && ao.ContainsKey("$w"))) res["hex"] = Hex(ms.ToArray());
                    else pos.Add((int)ms.Position);
                }
            }
            if (outs.Count > 0) res["out"] = outs;
            if (pos.Count > 0) res["pos"] = pos;
        }
        catch (Exception e)
        {
            var ie = e is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : e;
            res = new JsonObject { ["err"] = ie.GetType().Name };
        }
        return res;
    }

    // ---------- Dump ----------
    static string LowerFirst(string s) => char.ToLowerInvariant(s[0]) + s.Substring(1);

    public static JsonNode Dump(object o, int depth)
    {
        if (o == null) return null;
        if (depth > 8) return "<deep>";
        switch (o)
        {
            case bool b: return b;
            case byte x: return (int)x;
            case sbyte x: return (int)x;
            case short x: return (int)x;
            case ushort x: return (int)x;
            case int x: return x;
            case uint x: return (long)x;
            case long x: return x.ToString();
            case ulong x: return x.ToString();
            case float f: return F((double)f);
            case double d: return F(d);
            case char c: return c.ToString();
            case string s: return s;
            case Enum e: return Convert.ToInt64(e);
            case DateTime dt: return new JsonObject { ["$ms"] = dt.Ticks / 10000 };
            case byte[] ba when o.GetType() == typeof(byte[]): return new JsonObject { ["$hex"] = Hex(ba) };
            case PValue pv: return new JsonObject { ["$str"] = SafeStr(pv), ["hex"] = SafeSer(pv) };
            case PObject po: return new JsonObject { ["$str"] = SafeStr(po), ["hex"] = SafeSer(po) };
            case Stream: return null;
            case IDictionary d:
                {
                    var arr = new JsonArray();
                    foreach (DictionaryEntry de in d)
                    {
                        JsonNode k;
                        var kt = de.Key.GetType();
                        if (kt.IsGenericType && kt.FullName.StartsWith("System.Tuple"))
                            k = string.Join(":", kt.GetProperties().Select(p => p.GetValue(de.Key).ToString()));
                        else k = Dump(de.Key, depth + 1);
                        arr.Add(new JsonArray(k, Dump(de.Value, depth + 1)));
                    }
                    return new JsonObject { ["$dict"] = arr };
                }
            case IEnumerable en:
                {
                    var arr = new JsonArray();
                    foreach (var x in en) arr.Add(Dump(x, depth + 1));
                    return arr;
                }
        }
        var t = o.GetType();
        var res = new JsonObject();
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
            res[f.Name] = Dump(f.GetValue(o), depth + 1);
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.GetIndexParameters().Length > 0 || !p.CanRead) continue;
            try { res[p.Name] = Dump(p.GetValue(o), depth + 1); } catch { }
        }
        var ts = t.GetMethod("ToString", Type.EmptyTypes);
        if (ts.DeclaringType != typeof(object) && ts.DeclaringType != typeof(ValueType)) res["$str"] = SafeStr(o);
        return res;
    }
    static JsonNode SafeStr(object o) { try { return o.ToString(); } catch (Exception e) { return "<throws " + e.GetType().Name + ">"; } }
    static JsonNode SafeSer(object o)
    {
        try
        {
            var ms = new MemoryStream();
            t(o).GetMethod("Serialize", new[] { typeof(Stream) }).Invoke(o, new object[] { ms });
            return Hex(ms.ToArray());
        }
        catch { return "<throws>"; }
    }
    static Type t(object o) => o.GetType();
}
