using System;
using System.Collections.Generic;
using System.Linq;
using S7CommPlusDriver;
using static Interp;

static partial class Gen
{
    // Number -> string conversions (.NET float/double ToString) used by ToString() of Real/LReal and the tags
    static void GenFmt()
    {
        var rnd = new Random(99);
        var fl = new List<float>();
        for (int k = -12; k <= 20; k++) { fl.Add((float)Math.Pow(10, k)); fl.Add(1.5f * (float)Math.Pow(10, k)); fl.Add(1.23456789f * (float)Math.Pow(10, k)); fl.Add(-9.99999f * (float)Math.Pow(10, k)); }
        foreach (var x in new float[] { 1234567f, 12345678f, 123456789f, 16777216f, 16777217f, 9999999f, 99999999f, 0.0001f, 0.00001f, 0.000123f, 100000f, 1000000f, 10000000f, 0.1f, 0.2f, 0.3f, 1f / 3f, 2f / 3f, 100f / 3f, 1e15f, 1e14f, 123456790000000f })
            fl.Add(x);
        for (int i = 0; i < 150; i++) { var b = new byte[4]; rnd.NextBytes(b); var f = BitConverter.ToSingle(b, 0); if (!float.IsNaN(f) && !float.IsInfinity(f)) fl.Add(f); }
        for (int i = 0; i < 100; i++) fl.Add((float)(rnd.NextDouble() * Math.Pow(10, rnd.Next(-8, 12))));
        var dl = new List<double>();
        for (int k = -30; k <= 30; k++) { dl.Add(Math.Pow(10, k)); dl.Add(1.5 * Math.Pow(10, k)); dl.Add(1.2345678901234567 * Math.Pow(10, k)); dl.Add(-9.99999 * Math.Pow(10, k)); }
        foreach (var x in new double[] { 123456789012345.0, 1234567890123456.0, 12345678901234567.0, 999999999999999.0, 9999999999999998.0, 0.0001, 0.00001, 0.000123, 0.1, 0.2, 0.3, 1.0 / 3, 2.0 / 3, 100.0 / 3, 1e15, 1e14, 123456789012345680.0, 4.35, 0.1 + 0.2, 5e-324, 2.2250738585072014E-308, 1.7976931348623157E+308 })
            dl.Add(x);
        for (int i = 0; i < 200; i++) { var b = new byte[8]; rnd.NextBytes(b); var d = BitConverter.ToDouble(b, 0); if (!double.IsNaN(d) && !double.IsInfinity(d)) dl.Add(d); }
        for (int i = 0; i < 150; i++) dl.Add(rnd.NextDouble() * Math.Pow(10, rnd.Next(-8, 22)));
        int n = 0;
        foreach (var f in fl) Program.Run("fmt", "real-" + n++, New("ValueReal", A(f, 0)), STR);
        n = 0;
        foreach (var d in dl) Program.Run("fmt", "lreal-" + n++, New("ValueLReal", A(d, 0)), STR);
    }
}
