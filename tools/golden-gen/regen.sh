#!/bin/sh
# Regenerates test/golden.json.gz from the original C# driver (needs a .NET 8 SDK on PATH; no PLC, OpenSSL or sockets needed).
# Usage: tools/golden-gen/regen.sh [path-to-S7CommPlusDriver/src]   (default: ../S7CommPlusDriver/src next to this repo)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
src="${1:-$here/../../../S7CommPlusDriver/src}"
cd "$here"
dotnet build -c Release -p:S7Src="$(cd "$src" && pwd)" 2>&1 | tail -3
# The heap limit makes absurd allocations in the fuzz inputs fail fast (OutOfMemory vectors are dropped as machine dependent)
DOTNET_GCHeapHardLimit=0x60000000 dotnet run -c Release --no-build -- "$here/../../test/golden.json.gz" | grep -E "^(vectors|fuzz vectors|blob dict)"
