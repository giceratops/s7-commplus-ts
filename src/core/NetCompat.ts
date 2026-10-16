/**
 * Helpers emulating .NET runtime behaviour the C# driver relies on (internal, not part of the C# class layout):
 *  - `float.ToString()` / `double.ToString()` with the invariant culture, as used by the ToString() dumps: shortest
 *    round-trip digits, "E+XX"/"E-XX" exponent notation (at least two exponent digits), scientific notation when the
 *    decimal exponent is >= 9 (float) / >= 17 (double) or < -4;
 *  - `DateTime.ToString()` (invariant culture);
 *  - `Dictionary<K,V>.Add()` semantics (throws on duplicate keys).
 */

function format(neg: boolean, digits: string, e: number, maxExp: number): string {
  // value = 0.d1d2d3... * 10^(e+1), i.e. d1.d2d3... * 10^e
  let s: string;
  if (e >= maxExp || e < -4) {
    s = digits.charAt(0) + (digits.length > 1 ? "." + digits.slice(1) : "");
    const ae = Math.abs(e);
    s += "E" + (e < 0 ? "-" : "+") + (ae < 10 ? "0" : "") + ae.toString();
  } else if (e >= 0) {
    if (digits.length <= e + 1) s = digits + "0".repeat(e + 1 - digits.length);
    else s = digits.slice(0, e + 1) + "." + digits.slice(e + 1);
  } else {
    s = "0." + "0".repeat(-e - 1) + digits;
  }
  return (neg ? "-" : "") + s;
}

function special(v: number): string | null {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  return null;
}

/** double.ToString() */
export function doubleToString(v: number): string {
  const sp = special(v);
  if (sp !== null) return sp;
  const neg = v < 0;
  const a = Math.abs(v);
  const str = a.toExponential(); // shortest round-trip digits
  const [m, ex] = str.split("e");
  return format(neg, m.replace(".", "").replace(/0+$/, "") || "0", parseInt(ex, 10), 17);
}

/**
 * toExponential() rounds an exact decimal tie half-up; .NET picks the digit string with an even last digit
 * (e.g. 1730668.25f -> "1730668.2"). If the string with the last digit decremented also round-trips and is exactly
 * as close to the value, prefer the even one.
 */
function tie(a: number, t: string, roundTrips: (x: number) => boolean): string {
  const [m, ex] = t.split("e");
  const last = m.charCodeAt(m.length - 1) - 48;
  if (m.length < 1 || last < 1 || last % 2 === 0 || last > 9) return t;
  const alt = m.slice(0, -1) + String(last - 1) + "e" + ex;
  const av = parseFloat(alt);
  const tv = parseFloat(t);
  if (roundTrips(av) && Math.abs(a - av) === Math.abs(tv - a)) return alt;
  return t;
}

/** float.ToString(): v must hold a single precision value */
export function singleToString(v: number): string {
  const sp = special(v);
  if (sp !== null) return sp;
  const neg = v < 0;
  const a = Math.abs(v);
  let str = a.toExponential();
  for (let p = 0; p <= 8; p++) {
    const t = a.toExponential(p);
    if (Math.fround(parseFloat(t)) === a) { str = tie(a, t, (x) => Math.fround(x) === a); break; }
  }
  const [m, ex] = str.split("e");
  return format(neg, m.replace(".", "").replace(/0+$/, "") || "0", parseInt(ex, 10), 9);
}

/**
 * DateTime.ToString() (invariant culture, "MM/dd/yyyy HH:mm:ss") of a UTC DateTime, e.g. Notification.Add1Timestamp /
 * Utils.DtFromValueTimestamp. Uses the UTC fields of `d`.
 */
export function utcDateTimeToString(d: Date): string {
  const p = (n: number, w: number) => n.toString().padStart(w, "0");
  return (
    p(d.getUTCMonth() + 1, 2) + "/" + p(d.getUTCDate(), 2) + "/" + p(d.getUTCFullYear(), 4) + " " +
    p(d.getUTCHours(), 2) + ":" + p(d.getUTCMinutes(), 2) + ":" + p(d.getUTCSeconds(), 2)
  );
}

/** Dictionary<K,V>.Add(): throws on duplicate keys (instead of overwriting like Map.set) */
export function dictAdd<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) throw new Error("An item with the same key has already been added. Key: " + String(key));
  map.set(key, value);
}
