# golden-gen: differential test generator (C# original -> golden vectors)

There is no PLC in CI, so wire-level parity of the TypeScript port is verified by *differential testing* against the
original C# driver. This .NET 8 console project compiles the pure-protocol sources of the original
`S7CommPlusDriver` **unmodified, via `<Compile Include>` links** (`Core/*.cs` except `CommRessources.cs`,
`ClientApi/PlcTag*.cs`, `ClientApi/ItemAddress.cs`, `Alarming/Alarms*.cs` data classes and the `Zlib.net` sources;
`S7CommPlusConnection` is a one-line stub in `Stubs.cs`). Everything that needs sockets/OpenSSL
(`Net/`, `OpenSSL/`, `S7CommPlusConnection`, `Legitimation`, `Browser`, `Subscription`, `AlarmsHandler`, `BrowseAlarms`,
`CommRessources`, `PlcTags`) is not compiled and therefore not covered.

The harness builds objects from JSON *specs* by reflection, runs them (Serialize / ToString / Deserialize /
ProcessReadResult / GetWriteValue / ...), and records the results: serialized bytes (hex), `ToString()` dumps, decoded
field values, and whether an exception was thrown. The same specs are interpreted against the TS port by
`test/golden.test.ts`.

Covered: constants (`Ids`, `Datatype`, `Opcode`, `Functioncode`, `ElementID`, `ProtocolVersion`, `Softdatatype`), `S7p`
encode/decode incl. all VLQ variants and edge values, `Utils`, every `PValue` type (scalars, arrays, address arrays,
sparse arrays, blobs, WString, struct and packed struct; with and without VLQ), all request classes
(sessions/sequence numbers/integrity ids with and without integrity id, 3 protocol versions), `ItemAddress`,
`PObject` trees, `PVartypeList`/`PVarnameList`/`POffsetInfoType`, all response classes, `Notification`,
`SystemEvent`, every `PlcTag` type (write value + read result), alarm data classes, `BlobDecompressor` (zlib with all
built-in dictionaries) and ~6000 seeded random mutations (bit flips, truncation, insertion) of the canned byte streams to
compare the behaviour on corrupt input (including "throws" vs "does not throw").

## Regenerate

```sh
# needs a .NET 8 SDK (e.g. https://dot.net/v1/dotnet-install.sh --channel 8.0) and the original C# repo next to this one
tools/golden-gen/regen.sh [path/to/S7CommPlusDriver/src]     # writes test/golden.json.gz
npx vitest run test/golden.test.ts                           # compares the TS port with the golden vectors
```

`test/golden.json.gz` is committed (the plain JSON is ~30 MB); the test also accepts a plain `test/golden.json`.
Fuzz vectors whose C# run did not finish within 2 s or ran out of memory are dropped (machine dependent), so the exact
vector count can vary by a few between runs. `GOLDEN_REPORT=<file>` makes the test write all mismatches to a file,
`GOLDEN_GROUP=<regex>` restricts the run to some vector groups.

## Documented deviations (excluded or relaxed in `test/golden.test.ts`)

* `ValueWString.serialize` writes the UTF-8 *byte* length (C# writes the char count, wrong for non-ASCII): serialized
  bytes of vectors containing non-ASCII text are not compared (decoded values / `ToString` still are).
* `PlcTagDateAndTimeArray.processReadResult` reads the ms nibble of element n from `v[pos + 7]` (C# always `v[7]`).
* `S7p.decodeOctets` returns an empty array where C# returns `null` (blob without data).
* String tags are initialised with `""`/`[]` (C#: `null`, so `GetWriteValue` throws on an uninitialised tag).
* A decoded NaN keeps neither sign nor payload bits (JS numbers); a NaN that is *written* uses the C# `float.NaN` /
  `double.NaN` bit pattern.
* Deserialize methods return the number of consumed bytes as `position - start` (documented in `PORTING.md`); the
  C# return values are not compared, the stream position is.
