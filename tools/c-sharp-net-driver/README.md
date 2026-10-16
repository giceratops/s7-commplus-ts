# c-sharp-net-driver: the original C# network layer against the mock PLC

`tools/golden-gen` covers the pure protocol classes of the C# driver. This harness closes the remaining gap: it
compiles the **complete, unmodified** C# driver (`<Compile Include>` links to `../S7CommPlusDriver/src`, incl. `Net/S7Client`,
`Net/MsgSocket`, `OpenSSL/*`, `S7CommPlusConnection` with its partials Legitimation / Alarming / Subscriptions and
`ClientApi/Browser`, `PlcTags`) for `net8.0` and runs it, with real OpenSSL, against the same in-process mock PLC
(`test/mock-plc/`) that tests the TS client.

* `Program.cs`: scenarios (twins of `test/csharp-diff/scenarios.ts`). A `NativeLibrary.SetDllImportResolver` maps the
  `libssl-3-x64.dll` / `libcrypto-3-x64.dll` P/Invokes to the system `libssl.so.3` / `libcrypto.so.3` (OpenSSL 3 runtime).
  The port is set by reflection on the private static `S7Client.ISOTCP` (default 102, read by the `PLCPort` field
  initialiser), so the mock listens on a free high port and nothing needs root. The culture is forced to invariant
  (the `ToString()` dumps of the driver are culture dependent; the port emulates the invariant one).
* `record.ts`: starts one mock PLC per scenario, runs the C# client against it, answers the harness' `@@CMD` requests
  (change a PLC value, push an alarm), and writes `recording.json`: the steps/results seen by the C# client plus every
  request PDU the mock received (decrypted bytes, sequence number, integrity id, session id, fragment count), the
  legitimation records and TLS info. Challenges are fixed (`fixedChallenge`); the new-login ciphertext, which depends on the
  random TLS exporter secret, is masked (its decoded payload is compared instead).
* `test/csharp-diff.test.ts` replays the same scenarios with the TS client and requires equal steps and request streams.
  It is skipped if `recording.json` is absent.

```sh
# .NET 8 SDK (https://dot.net/v1/dotnet-install.sh --channel 8.0), OpenSSL 3 runtime libs (libssl.so.3, libcrypto.so.3)
DOTNET=/path/to/dotnet npx tsx tools/c-sharp-net-driver/record.ts [scenario...]   # all scenarios take ~3 min (timeouts)
npx vitest run test/csharp-diff.test.ts
```
`CS_LOG=1` additionally writes the console output of each C# run to `log-<scenario>.txt` (ignored by git).

Scenarios: connect/disconnect, legitimation (legacy, new, new with user name, both denied, unprotected PLC, no password
on a protected PLC), browse (+ variants with differently framed answers), symbol resolution, read/write of many tag
types (incl. a 2000 byte fragmented write, per-item errors), read/write chunking by SystemLimits, comments + operating
state, subscription with change notifications and credit limit extension, alarm subscription + alarm notification, and
17 error paths (refused, COTP, InitSsl, TLS, CreateObject, SetMultiVariables, dropped / failed / closed reads, unanswered
DeleteObject).

Not covered: `ExploreASAlarms` / `GetActiveAlarms` (BrowseAlarms) and `CommRessources.ReadFree`, because the mock PLC
does not implement those requests.

## Findings

Request streams and results were identical for all scenarios except the following (asserted in `KNOWN` of the test):

| scenario | C# original | TS port |
|---|---|---|
| `browse-split` (an S7+ fragment spread over two TLS records) | process dies: `OnDataReceived` throws `ArgumentOutOfRangeException` in `MemoryStream.Write` on the receive thread | re-frames the stream, completes |
| `err-tls-garbage` (non-TLS bytes as answer to the ClientHello) | hangs forever (`OpenSSLConnector.RunSSL` spins) | returns an error |
| `err-initssl-errresp` (error response to InitSsl) | `Connect()` returns 0 (success) without a session | returns `errIsoInvalidPDU` |
| `err-tls-close` (PLC closes during the handshake) | `Connect()` returns `errTCPDataReceive` (5) after the read timeout; send failures are never noticed | fails at once with `errTCPDataSend` (7) |

All four are documented deviations (README.md, "Differences from the C# driver").
