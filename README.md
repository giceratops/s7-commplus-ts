# s7-commplus-ts

TypeScript port of [S7CommPlusDriver](https://github.com/thomas-v2/S7CommPlusDriver) (Thomas Wiens, LGPL-3.0):
a client for the S7CommPlus protocol of Siemens S7-1200 (FW >= 4.3) / S7-1500 (FW >= 2.9) PLCs with TLS.
Runs on Node.js >= 18 (uses `node:net`, `node:tls`, `node:crypto`, `node:zlib`; no OpenSSL DLLs needed).

> Status: faithful port of the full C# driver (connection, browse, read/write tags, subscriptions, alarms,
> legitimation, blob decompression). Codec-level unit tests and C# differential (golden vector) tests exist, and the whole
> network stack (ISO-on-TCP, TLS 1.3, session setup, legitimation, browse, read/write, subscriptions, alarms) is exercised
> end to end against an in-process mock PLC (`test/mock-plc/`, see below), and the original C# network layer was run against the
> same mock PLC to compare results and request streams (`tools/c-sharp-net-driver/`). It has **not yet been verified against a real PLC**.

## Install
```
npm install github:giceratops/s7-commplus-ts
```

## Usage
```ts
import { S7CommPlusConnection, tagFactory, readTags } from "s7-commplus-ts";

const conn = new S7CommPlusConnection();
const res = await conn.connect("192.168.0.1", "password"); // 0 = OK
if (res !== 0) throw new Error(`connect failed: ${res}`);

const { res: r, varInfoList } = await conn.browse();
const { res: rr, values, errors } = await conn.readValues(addresses);
await conn.disconnect();
```
See `examples/driver-test.ts`. Porting conventions (camelCase members, bigint for 64-bit values, numeric
error codes preserved, `out` params returned as result objects) are in `PORTING.md`.

## Interactive browser (terminal)
`examples/browser.ts` is a cross-platform interactive REPL that replaces the Windows-only WinForms app
`S7CommPlusGUIBrowser`. It is unverified against real hardware.
```
npx tsx examples/browser.ts <ip> [password] [user]     # or: npm run browser -- <ip> [password] [user]
```
Type `help` inside for the command list. `write`, `state` change the PLC: use with care.

| Form1 feature | Command |
|---|---|
| IP / Password / Username fields + Connect button (also command-line args 1-3) | `connect <ip> [password] [user]` (or args) |
| Disconnect button | `disconnect` |
| Status label | `status` (plus `[...]` status lines) |
| Tree root: datablocks + Inputs/Outputs/Merker/S7Timers/S7Counters | loaded on connect; `ls /` |
| Expand tree node (lazy type-info load, arrays, multi-dim arrays) | `ls [path]`, `cd <node>`, `pwd`, `tree [depth]` |
| Select tree node (builds the TIA symbol name and reads it) | `select <node>` |
| Symbol field + Read button (symbolic address, value) | `read <symbol>` |
| (driver API, not in the form) write tags | `write <symbol> <value>` |
| (driver API) subscriptions | `monitor <cycleMs> <count> <symbol...>` |
| (driver API) comments XML | `comments <db name\|number\|0xrelid>` |
| (driver API) PLC operating state | `state <stop\|run\|n>` |
| (driver API) alarms | `alarms`, `alarmdefs`, `alarmwatch` |

## Tests
```
npm test            # = npx vitest run
```
- `test/golden.test.ts`: byte-identical comparison with the C# driver (golden vectors, see `PORTING.md`).
- `test/integration.test.ts` + `test/mock-plc/`: an in-process **mock S7-1500** (a `node:net` server speaking ISO-on-TCP/COTP,
  the unencrypted InitSsl exchange, a real TLS 1.3 server handshake tunnelled through DT TPDUs, and the S7+ session,
  legitimation, read/write, explore/browse, delete, subscription and alarm messages). The self-signed certificate is
  generated at test time with the `openssl` CLI into a temporary directory (nothing is committed). The mock validates the
  client's sequence numbers, integrity ids, session ids, address sub areas and value types and records deviations.
  The TLS layer is additionally cross-checked against `openssl s_server` (OMS exporter secret, forced cipher suites).
  Needs the `openssl` CLI on the PATH.
- `test/csharp-diff.test.ts` + `tools/c-sharp-net-driver/`: the **original C# driver including its network layer** (compiled
  unmodified for .NET 8, real OpenSSL) was run against the same mock PLC; `recording.json` holds its results and the request
  PDUs the mock received, and the test requires the TS client to produce the same for 37 scenarios (see the tool's README).

## Differences from the C# driver
- Async/Promise API instead of blocking calls; no threads.
- TLS via Node's `tls` (TLS 1.3) instead of OpenSSL; set `conn.client.keyLogEnabled = true` for Wireshark key logs.
- `ValueWString` serialises the UTF-8 byte length (C# used the char count).
- `S7CommPlusConnection.plcPort`, `connTimeout`, `isoRecvTimeout`: TCP port (default 102) and socket timeouts for `connect()`
  (C# hard-codes them). Useful for simulators / port forwards.
- Received S7+ data is re-framed into fragments before the C# reassembly logic runs (Node's `TLSSocket` does not guarantee that
  one `data` event is one TLS record, OpenSSL's `SSL_read` did).
- `connect()` can be called again on the same object (all per-session state is reset); `disconnect()` is a no-op when not
  connected, and does not wait for an answer when the connection is already gone; `readValues` returns a failed send at once.
- A malformed PDU never throws out of the socket handler (it sets `lastError = errIsoInvalidPDU`).
- `connect()` no longer returns 0 (success) when the InitSsl answer is an unexpected PDU.
- A failing send (socket already closed, TLS handshake failed) is reported at once as `errTCPDataSend` (7) instead of being
  ignored; the C# driver never notices it (`SendS7plusPDUdata` returns its own `m_LastError`), waits for the read timeout and
  reports `errTCPDataReceive` (5).
- Where the C# network layer hangs or crashes (non-TLS bytes as answer to the ClientHello: `OpenSSLConnector.RunSSL` spins forever;
  an S7+ fragment spread over two TLS records: `ArgumentOutOfRangeException` on the receive thread) the port returns an error / works.

All other behaviour of the network layer is verified to be identical (return codes, tag values, request PDU bytes, sequence /
integrity / session ids) against the original C# driver running with real OpenSSL, see `tools/c-sharp-net-driver/README.md`.

## Known limitations inherited from the C# driver
- There is a single response queue: a subscription / alarm notification, or a late answer to a request that already timed out,
  is taken for the answer of the next request while a subscription is active (the C# sources flag this as "needs some more
  redesign"). Do not mix polling requests with active subscriptions on one connection.
