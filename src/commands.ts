import { bold, dim, green, red } from "./colors.ts";
import { CONFIG_FILE, defaultConfig, loadConfig } from "./config.ts";
import { readVerdict, renderHuman, writeVerdict } from "./report.ts";
import { runPipeline } from "./runner.ts";
import type { HyperfixerConfig } from "./types.ts";

const STALE_AFTER_MS = 10 * 60_000;

export interface RunFlags {
  json: boolean;
  quiet: boolean;
  configPath: string;
  only: string[] | null;
  noFailFast: boolean;
  outDir: string | null;
  maxCost: number | null;
}

export async function cmdRun(flags: RunFlags): Promise<number> {
  let config: HyperfixerConfig;
  try {
    config = await loadConfig(flags.configPath);
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  const only = flags.only;
  if (only) {
    const known = new Set(config.gates.map((g) => g.name));
    const unknown = only.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      console.error(red(`unknown gate(s): ${unknown.join(", ")}`));
      console.error(dim(`available: ${[...known].join(", ")}`));
      return 2;
    }
    config.gates = config.gates.map((g) => ({
      ...g,
      enabled: only.includes(g.name),
    }));
  }
  const maxCost = flags.maxCost;
  if (maxCost !== null) {
    config.gates = config.gates.map((g) =>
      g.cost <= maxCost ? g : { ...g, enabled: false },
    );
  }
  if (flags.noFailFast) config.failFast = false;
  if (flags.outDir !== null) config.outDir = flags.outDir;

  const verdict = await runPipeline(config);
  const path = await writeVerdict(verdict, config.outDir);
  if (flags.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (!flags.quiet) {
    console.log(renderHuman(verdict));
    console.log(dim(`verdict: ${path}`));
  }
  return verdict.ok ? 0 : 1;
}

export async function cmdInit(): Promise<number> {
  if (await Bun.file(CONFIG_FILE).exists()) {
    console.error(`${CONFIG_FILE} already exists, not overwriting`);
    return 2;
  }
  await Bun.write(CONFIG_FILE, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  console.log(`wrote ${bold(CONFIG_FILE)}, enable/adjust gates, then: hyperfixer run`);
  return 0;
}

/** Print the last verdict's first actionable hint, for agent consumption. */
export async function cmdHint(configPath: string): Promise<number> {
  let config: HyperfixerConfig;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  const verdict = await readVerdict(config.outDir);
  if (!verdict) {
    console.error(`no verdict found in ${config.outDir}/, run "hyperfixer run" first`);
    return 2;
  }
  const ageMs = Date.now() - Date.parse(verdict.generatedAt ?? "");
  if (!Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS) {
    console.error('warning: verdict may be stale, re-run "hyperfixer run"');
  }
  console.log(
    verdict.ok ? "OK, nothing to fix" : (verdict.hint ?? "FAIL, see verdict.json"),
  );
  return verdict.ok ? 0 : 1;
}

async function toolAvailable(argv: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
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

  report(await toolAvailable(["bun", "--version"]), "bun");
  report(
    await toolAvailable(["bunx", "tsc", "--version"]),
    "typescript (tsc)",
    "bun add -d typescript",
  );

  try {
    const config = await loadConfig(configPath);
    report(
      true,
      `config (${(await Bun.file(configPath).exists()) ? configPath : "defaults"})`,
    );
    const enabled = config.gates.filter((g) => g.enabled !== false);
    console.log(
      dim(`  enabled gates: ${enabled.map((g) => g.name).join(", ") || "none"}`),
    );
    const mutation = config.gates.find(
      (g) => g.name === "mutation" && g.enabled !== false,
    );
    if (mutation) {
      report(
        await toolAvailable(["bunx", "stryker", "--version"]),
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
