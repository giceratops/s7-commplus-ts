using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using static Interp;

static partial class Gen
{
    static void GenFuzz()
    {
        var rnd = new Random(20240607);
        var groups = new HashSet<string> { "pvalue-dec", "resp", "notif", "pobject-dec", "sysevent", "alarm" };
        var corpus = Program.Vectors.Where(v => !((string)v["id"]).StartsWith("withlists") && groups.Contains((string)v["group"]) && v["do"] is JsonArray d && d.Count > 0 && d[0] is JsonArray c && c.Count > 1 && c[1] is JsonObject so && so.ContainsKey("$stream")).ToList();
        Console.WriteLine("fuzz corpus: " + corpus.Count);
        Program.WatchdogEnabled = false;
        int n = 0, added = 0, skippedHang = 0, skippedOom = 0;
        foreach (var v in corpus)
        {
            for (int k = 0; k < 3; k++)
            {
                var call = (JsonArray)v["do"][0].DeepClone();
                var bytes = FromHex((string)call[1]["$stream"]);
                if (bytes.Length == 0) continue;
                var b = bytes.ToList();
                switch (rnd.Next(4))
                {
                    case 0: b[rnd.Next(b.Count)] = (byte)rnd.Next(256); break;
                    case 1: b[rnd.Next(b.Count)] ^= (byte)(1 << rnd.Next(8)); break;
                    case 2: { int at = rnd.Next(b.Count); b.RemoveRange(at, 1 + rnd.Next(Math.Min(4, b.Count - at))); break; }
                    case 3: b.Insert(rnd.Next(b.Count + 1), (byte)rnd.Next(256)); break;
                }
                call[1] = new JsonObject { ["$stream"] = Hex(b.ToArray()) };
                var obj = v["obj"].DeepClone();
                var fid = (string)v["group"] + "-" + (string)v["id"] + "-" + k + "#" + n;
                var task = System.Threading.Tasks.Task.Run(() => Program.Execute("fuzz", fid, obj, call));
                Program.Current = "fuzz-wait";
                n++;
                if (!task.Wait(2000)) { skippedHang++; Console.WriteLine("fuzz hang skipped: " + fid); continue; }
                var res = task.Result;
                var ex = res["expect"]?[0]?["err"]?.ToString();
                // outcomes that depend on the machine (memory) are not reproducible: drop them
                if (ex == "OutOfMemoryException") { skippedOom++; continue; }
                Program.Vectors.Add(res);
            }
        }
        Console.WriteLine("fuzz vectors: " + (n - skippedHang - skippedOom) + " skipped hang=" + skippedHang + " oom=" + skippedOom);
    }
}
