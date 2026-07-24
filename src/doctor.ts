import { dim, green, red } from "./colors.ts";
import type { RunFlags } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { globSync } from "./glob.ts";
import { fileExists, spawnSyncCapture } from "./runtime.ts";

function toolAvailable(argv: string[]): boolean {
  return spawnSyncCapture(argv).exitCode === 0;
}

/** Check toolchain and config health. */
export async function cmdDoctor(flags: RunFlags): Promise<number> {
  const configPath = flags.configPath;
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
    const config = await loadConfig(configPath, flags.configExplicit);
    report(true, `config (${fileExists(configPath) ? configPath : "defaults"})`);
    const enabled = config.gates.filter((g) => g.enabled !== false);
    console.log(
      dim(`  enabled gates: ${enabled.map((g) => g.name).join(", ") || "none"}`),
    );
    // Any input pattern matching nothing is worth saying out loud. If they all
    // die the gate is simply uncacheable, but if only some do the cache key is
    // built from what is left, and a change under a dead pattern replays a
    // stale pass. Resolve the globs only: hashing content would answer the
    // same question after reading the whole repository.
    for (const gate of enabled) {
      const dead = (gate.inputs ?? []).filter((p) => globSync(p).length === 0);
      if (dead.length === 0) continue;
      const all = dead.length === (gate.inputs ?? []).length;
      report(
        false,
        `gate "${gate.name}": ${all ? "inputs match no file" : "some inputs match no file"} (${dead.join(", ")})`,
        all
          ? "only *, ** and ? are supported, braces and character classes are not"
          : "the cache key ignores them, so a change there would replay a stale pass",
      );
    }
    const mutation = config.gates.find(
      (g) => g.name === "mutation" && g.enabled !== false,
    );
    if (mutation) {
      report(
        toolAvailable(["bunx", "@stryker-mutator/core", "--version"]) ||
          toolAvailable(["npx", "@stryker-mutator/core", "--version"]),
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
  // Everything doctor checks is setup, never code: exit 2 per the contract.
  return failures === 0 ? 0 : 2;
}
