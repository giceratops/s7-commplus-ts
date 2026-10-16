/*
 * Differential test of the network layer against the ORIGINAL C# driver.
 *
 * tools/c-sharp-net-driver/recording.json was produced by running the unmodified C# S7CommPlusDriver (Net/S7Client,
 * OpenSSL/*, S7CommPlusConnection with Legitimation / Alarming / Subscriptions / Browser / PlcTags) with real OpenSSL
 * against the same in-process mock PLC (`tools/c-sharp-net-driver/record.ts`). Here the identical scenarios
 * (test/csharp-diff/scenarios.ts) are run with the TS client and the results (return codes, tag values, errors,
 * ToString dumps) and the request PDUs received by the mock PLC (after TLS decryption: bytes, sequence numbers, integrity
 * ids, session ids) must be equal. Skipped when the recording is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIOS, runTsRecording } from "./csharp-diff/scenarios.js";
import type { MockRecording, Step } from "./csharp-diff/scenarios.js";

interface Recording {
  scenarios: Record<string, { steps: Step[]; mock: MockRecording }>;
}

const file = join(dirname(fileURLToPath(import.meta.url)), "../tools/c-sharp-net-driver/recording.json");
const rec: Recording | null = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Recording) : null;

/**
 * Scenarios where the TS client intentionally (or because the C# driver cannot do it) differs. Documented in README.md
 * ("Differences from the C# driver"). For these the recorded C# behaviour and the expected TS behaviour are asserted
 * explicitly instead of equality of the steps.
 */
const KNOWN: Record<string, { why: string; cs: (s: Step[]) => void; ts: (s: Step[]) => void; requests?: "prefix" }> = {
  // A fragment of a response that is spread over two TLS records makes OnDataReceived throw (MemoryStream.Write with a
  // length beyond the buffer) on the receive thread: the whole C# process dies.
  "browse-split": {
    why: "C# crashes when an S7+ fragment spans two TLS records",
    cs: (s) => expect(s).toEqual([{ step: "harness-crash", exit: null, signal: "SIGABRT" }]),
    ts: (s) => expect(s.map((x) => x.res ?? x.step)).toEqual([0, 0, 0, "disconnect"]),
    requests: "prefix",
  },
  // C#: InitSslResponse.DeserializeFromPdu returns null -> `return m_LastError` (0) -> connect() reports success without a session.
  "err-initssl-errresp": {
    why: "C# connect() returns 0 (success) when the InitSsl answer is an error response",
    cs: (s) => expect(s.map((x) => x.res ?? x.step)).toEqual([0, 5, "disconnect"]),
    ts: (s) => expect(s).toEqual([{ step: "connect", res: 196608 }]), // errIsoInvalidPDU
  },
  // C#: garbage instead of a ServerHello makes OpenSSLConnector.RunSSL spin forever (the unconsumed bytes are never dropped).
  "err-tls-garbage": {
    why: "C# hangs when the PLC answers the ClientHello with non-TLS bytes",
    cs: (s) => expect(s).toEqual([{ step: "harness-crash", exit: null, signal: "SIGKILL" }]),
    ts: (s) => expect(s).toEqual([{ step: "connect", res: 7 }]),
  },
  // C# never notices a failed send (SendS7plusPDUdata returns its own m_LastError), it waits for the read timeout and
  // reports errTCPDataReceive (5); the port reports the failed send at once (errTCPDataSend, 7).
  "err-tls-close": {
    why: "send failures are reported immediately (errTCPDataSend) instead of after the read timeout (errTCPDataReceive)",
    cs: (s) => expect(s).toEqual([{ step: "connect", res: 5 }]),
    ts: (s) => expect(s).toEqual([{ step: "connect", res: 7 }]),
  },
};

describe.skipIf(rec === null)("TS client vs recording of the original C# driver", () => {
  it("the recording covers every scenario", () => {
    expect(Object.keys(rec!.scenarios).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  for (const name of Object.keys(SCENARIOS)) {
    it(`scenario ${name}`, async () => {
      const cs = rec!.scenarios[name];
      expect(cs, "no recording for " + name).toBeTruthy();
      const ts = await runTsRecording(name);
      const known = KNOWN[name];

      // results seen by the client
      if (known) {
        known.cs(cs.steps);
        known.ts(ts.steps);
      } else {
        expect(ts.steps).toEqual(cs.steps);
      }

      // request PDUs seen by the mock PLC (bytes, sequence numbers, integrity ids, session ids ...)
      if (known?.requests === "prefix") {
        expect(ts.mock.requests.slice(0, cs.mock.requests.length)).toEqual(cs.mock.requests);
      } else {
        expect(ts.mock.requests).toEqual(cs.mock.requests);
      }
      expect(ts.mock.legitimations).toEqual(cs.mock.legitimations);
      expect(ts.mock.crInfos).toEqual(cs.mock.crInfos);
      expect(ts.mock.tls).toEqual(cs.mock.tls);
      expect(ts.mock.writes).toEqual(cs.mock.writes);
      expect(ts.mock.operatingState).toEqual(cs.mock.operatingState);
      // neither client violated the protocol rules the mock checks
      expect(cs.mock.violations).toEqual([]);
      expect(ts.mock.violations).toEqual([]);
    }, 60_000);
  }
});
