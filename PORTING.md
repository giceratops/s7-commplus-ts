# Porting conventions (C# S7CommPlusDriver -> TypeScript)

Source: /home/gi/dev/github.com/giceratops/S7CommPlusDriver/src/S7CommPlusDriver
Target: /home/gi/dev/github.com/giceratops/s7-commplus-ts/src  (ESM, NodeNext: relative imports MUST end in `.js`)

Layout: C# folder -> lowercase dir (Core->core, Net->net, Alarming->alarming, Legitimation->legitimation,
ClientApi->clientapi, Subscriptions->subscriptions). File name = C# class name (e.g. `core/PValue.ts`). Top-level
`S7CommPlusConnection.cs` -> `src/S7CommPlusConnection.ts`. Named exports only. Each dir gets an `index.ts` re-exporting everything.

- Streams: `System.IO.Stream/MemoryStream` -> `ByteStream` (`src/core/ByteStream.ts`): position, length, writeByte, write, readByte, read, toArray.
- byte[] -> `Uint8Array`. Integers <=32 bit -> `number`. UInt64/Int64 -> `bigint` (everywhere: fields, VLQ64, timestamps, LWORD...).
- `S7p.decodeXxx(buf)` returns the VALUE (not the byte count; the C# `out` param becomes the return value; 0/empty when
  insufficient data, like C#). Where C# sums `ret += Decode...`, instead compute consumed bytes as `buf.position - start`.
  `S7p.encodeXxx(buf, v)` keeps returning the number of bytes written. Methods that use `out` for several results return an object/tuple.
- Naming: classes/interfaces/enums keep PascalCase. Instance members (fields, properties, methods) -> camelCase
  (`ExploreId`->`exploreId`, `Serialize`->`serialize`, `ToString`->`toString`). C# properties become plain fields/getters.
  Constant-holder classes and enums (Opcode, Functioncode, Ids, Datatype, ElementID, Softdatatype, ProtocolVersion, ...)
  become `export const Name = { Member: value } as const` with member names EXACTLY as in C# (plus `export type Name = typeof Name[keyof typeof Name]` where it's an enum). 
  Static methods -> camelCase static methods.
- Blocking calls become `async`/Promises. `int` error codes (0 = OK, else S7 error code) returning APIs KEEP returning numeric codes
  (e.g. `Promise<number>`), and `out` params become fields of a returned result object, e.g. `{ res: number, values: ..., errors: ... }`
  -- keep this faithful so behaviour matches the C# driver.
- Keep the algorithmic logic byte-for-byte identical to the C# code. Do not "improve" behaviour. Keep comments that explain protocol quirks.
- Keep the original license header (LGPL, Thomas Wiens) as a short comment, plus "Ported to TypeScript".
- `ToString()` XML-ish dumps: port them too (`toString()`).
- uint arithmetic: mask with `>>> 0` where unsigned 32-bit semantics matter.
- Strings: UTF-8 via TextDecoder/TextEncoder (or Buffer). 
- Typecheck with `npx tsc --noEmit` from the project root. Other modules are being ported concurrently by other agents: import from
  them by the agreed path/name (e.g. `import { PValue } from "./PValue.js"`) even if the file is not there yet; do NOT create/modify files outside your assignment.

## Differential testing against the C# driver

`tools/golden-gen` (C#, .NET 8) compiles the original pure-protocol sources unmodified and emits golden vectors to
`test/golden.json.gz` (serialization of every PValue/request/tag type, canned PDU decoding, fuzzed corrupt input, ...);
`test/golden.test.ts` replays the same specs against the port and requires byte-identical output / identical decoded
fields / identical "throws". See `tools/golden-gen/README.md` for regeneration and the list of documented deviations.
Helpers that emulate .NET behaviour (float/double/DateTime formatting, `Dictionary.Add`) live in `src/core/NetCompat.ts`.
