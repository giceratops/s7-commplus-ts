using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using S7CommPlusDriver;

static class Program
{
    public static volatile string Current;
    public static volatile bool WatchdogEnabled = true;
    public static List<JsonObject> Vectors = new List<JsonObject>();

    static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        string outPath = args.Length > 0 ? args[0] : "golden.json";
        var wd = new System.Threading.Thread(() =>
        {
            string last = null; int same = 0;
            while (true)
            {
                System.Threading.Thread.Sleep(3000);
                var cur = Current;
                if (!WatchdogEnabled) { same = 0; continue; }
                if (cur == last) { if (++same >= 7) { Console.Error.WriteLine("WATCHDOG: vector seems to hang: " + cur); Environment.Exit(2); } } else { last = cur; same = 0; }
            }
        }) { IsBackground = true };
        wd.Start();
        var root = new JsonObject();
        root["generator"] = "tools/golden-gen (C# S7CommPlusDriver, .NET " + Environment.Version + ")";
        root["constants"] = Gen.Constants();
        Gen.All();
        var arr = new JsonArray();
        foreach (var v in Vectors) arr.Add(v);
        root["vectors"] = arr;
        var json = root.ToJsonString();
        if (outPath.EndsWith(".gz"))
        {
            using (var fs = File.Create(outPath))
            using (var gz = new System.IO.Compression.GZipStream(fs, System.IO.Compression.CompressionLevel.SmallestSize))
            { var bytes = System.Text.Encoding.UTF8.GetBytes(json); gz.Write(bytes, 0, bytes.Length); }
        }
        else File.WriteAllText(outPath, json);
        Console.WriteLine("vectors: " + Vectors.Count + " -> " + outPath);
        return 0;
    }

    // Executes a vector in C# and records the expectations
    public static JsonObject Run(string group, string id, JsonNode obj, params JsonArray[] doList)
    {
        var v = Execute(group, id, obj, doList);
        Vectors.Add(v);
        return v;
    }

    // Executes a vector without registering it (used for the fuzz vectors that run on a worker thread with a timeout)
    public static JsonObject Execute(string group, string id, JsonNode obj, params JsonArray[] doList)
    {
        Current = group + "/" + id;
        var v = new JsonObject { ["group"] = group, ["id"] = id, ["obj"] = obj.DeepClone() };
        var calls = new JsonArray(); var expect = new JsonArray();
        object inst = null; Type t = null;
        try
        {
            var o = (JsonObject)obj;
            if (o.ContainsKey("static")) t = Interp.FindType((string)o["static"]);
            else { inst = Interp.Build(o); t = inst.GetType(); }
        }
        catch (Exception e) { v["buildErr"] = e.Message; return v; }
        foreach (var c in doList)
        {
            calls.Add(c.DeepClone());
            expect.Add(Interp.CallMethod(inst, t, c));
        }
        v["do"] = calls; v["expect"] = expect;
        return v;
    }
}
