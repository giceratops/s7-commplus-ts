/*
 * Runs every scenario of test/csharp-diff/scenarios.ts with the ORIGINAL C# driver (CsNetDriver.csproj) against the
 * in-process mock PLC and writes tools/c-sharp-net-driver/recording.json (steps returned by the C# client + the request
 * PDUs the mock received).
 *
 *   DOTNET=/path/to/dotnet npx tsx tools/c-sharp-net-driver/record.ts [scenario...]
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, applyPlcCommand, clientPort, recordMock, startScenarioPlc } from "../../test/csharp-diff/scenarios.js";
import type { MockRecording, PlcCommand, Step } from "../../test/csharp-diff/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const dotnet = process.env.DOTNET ?? "dotnet";

export interface Recording {
  generatedBy: string;
  scenarios: Record<string, { steps: Step[]; mock: MockRecording }>;
}

const build = spawnSync(dotnet, ["build", "-c", "Release", "-nologo", "-v", "q"], { cwd: here, stdio: "inherit" });
if (build.status !== 0) throw new Error("dotnet build failed");
const dll = join(here, "bin/Release/net8.0/CsNetDriver.dll");

async function runOne(name: string): Promise<{ steps: Step[]; mock: MockRecording; log: string }> {
  const plc = await startScenarioPlc(name);
  const def = SCENARIOS[name];
  const child = spawn(dotnet, [dll, "127.0.0.1", String(await clientPort(name, plc)), name, def.password ?? "", def.username ?? ""], { stdio: ["pipe", "pipe", "inherit"] });
  const killer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const rl = createInterface({ input: child.stdout });
  let result: { steps: Step[]; log: string } | null = null;
  const pending: Promise<void>[] = [];
  rl.on("line", (line) => {
    if (line.startsWith("@@CMD ")) {
      const cmd = JSON.parse(line.slice(6)) as PlcCommand;
      pending.push(applyPlcCommand(plc, cmd).then(() => void child.stdin.write("ok\n")));
    } else if (line.startsWith("@@RESULT ")) {
      result = JSON.parse(line.slice(9));
    } else {
      console.error("[cs stdout] " + line);
    }
  });
  const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("exit", (c, sg) => r([c, sg])));
  clearTimeout(killer);
  await Promise.all(pending);
  await new Promise((r) => setTimeout(r, 50));
  const mock = recordMock(plc);
  await plc.stop();
  // a crashed/hung client is a result as well (e.g. the C# receive path with unusual framing)
  const res = (result as { steps: Step[]; log: string } | null) ?? { steps: [{ step: "harness-crash", exit: code, signal } as Step], log: "" };
  return { steps: res.steps, mock, log: res.log };
}

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(SCENARIOS);
const out: Recording = { generatedBy: "tools/c-sharp-net-driver (original C# S7CommPlusDriver, net8.0, system OpenSSL 3)", scenarios: {} };
const file = join(here, "recording.json");
if (want.length && existsSync(file)) Object.assign(out.scenarios, (JSON.parse(readFileSync(file, "utf8")) as Recording).scenarios);
for (const n of names) {
  process.stderr.write(`scenario ${n} ...\n`);
  const r = await runOne(n);
  if (process.env.CS_LOG) writeFileSync(join(here, `log-${n}.txt`), r.log);
  out.scenarios[n] = { steps: r.steps, mock: r.mock };
  writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
}
console.error("wrote " + file);
