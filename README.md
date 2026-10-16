# s7-commplus-ts

TypeScript port of [S7CommPlusDriver](https://github.com/thomas-v2/S7CommPlusDriver) (Thomas Wiens, LGPL-3.0):
a client for the S7CommPlus protocol of Siemens S7-1200 (FW >= 4.3) / S7-1500 (FW >= 2.9) PLCs with TLS.
Runs on Node.js >= 18 (uses `node:net`, `node:tls`, `node:crypto`, `node:zlib`; no OpenSSL DLLs needed).

> Status: faithful port of the full C# driver (connection, browse, read/write tags, subscriptions, alarms,
> legitimation, blob decompression). Codec-level unit tests exist; it has **not yet been verified against a real PLC**.

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

## Differences from the C# driver
- Async/Promise API instead of blocking calls; no threads.
- TLS via Node's `tls` (TLS 1.3) instead of OpenSSL; set `conn.client.keyLogEnabled = true` for Wireshark key logs.
- `ValueWString` serialises the UTF-8 byte length (C# used the char count).
