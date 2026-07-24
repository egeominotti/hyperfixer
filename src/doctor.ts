import { dim, green, red } from "./colors.ts";
import { loadConfig } from "./config.ts";
import { fileExists, spawnSyncCapture } from "./runtime.ts";

function toolAvailable(argv: string[]): boolean {
  return spawnSyncCapture(argv).exitCode === 0;
}

/** Check toolchain and config health. */
export async function cmdDoctor(configPath: string): Promise<number> {
  let failures = 0;
  const report = (ok: boolean, label: string, fix?: string) => {
    console.log(
      `${ok ? green("✓") : red("✗")} ${label}${!ok && fix ? dim(`, ${fix}`) : ""}`,
    );
    if (!ok) failures++;
  };

  report(
    toolAvailable(["bun", "--version"]) ||
      toolAvailable(["node", "--version"]) ||
      toolAvailable(["deno", "--version"]),
    "runtime (bun, node or deno)",
  );
  report(
    toolAvailable(["bunx", "tsc", "--version"]) ||
      toolAvailable(["npx", "tsc", "--version"]),
    "typescript (tsc)",
    "bun add -d typescript (or npm i -D typescript)",
  );

  try {
    const config = await loadConfig(configPath);
    report(true, `config (${fileExists(configPath) ? configPath : "defaults"})`);
    const enabled = config.gates.filter((g) => g.enabled !== false);
    console.log(
      dim(`  enabled gates: ${enabled.map((g) => g.name).join(", ") || "none"}`),
    );
    const mutation = config.gates.find(
      (g) => g.name === "mutation" && g.enabled !== false,
    );
    if (mutation) {
      report(
        toolAvailable(["bunx", "stryker", "--version"]) ||
          toolAvailable(["npx", "stryker", "--version"]),
        "stryker (mutation gate enabled)",
        "bun add -d @stryker-mutator/core",
      );
    }
  } catch (e) {
    report(false, `config: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(
    failures === 0 ? green("\nall checks passed") : red(`\n${failures} check(s) failed`),
  );
  return failures === 0 ? 0 : 1;
}
