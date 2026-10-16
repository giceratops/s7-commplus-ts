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

## Differences from the C# driver
- Async/Promise API instead of blocking calls; no threads.
- TLS via Node's `tls` (TLS 1.3) instead of OpenSSL; set `conn.client.keyLogEnabled = true` for Wireshark key logs.
- `ValueWString` serialises the UTF-8 byte length (C# used the char count).
