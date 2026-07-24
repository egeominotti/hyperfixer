import { cachingExecutor, loadCache, pipelineFingerprint, saveCache } from "./cache.ts";
import { applyChanged, changedFiles } from "./changed.ts";
import { bold, dim, red } from "./colors.ts";
import { CONFIG_FILE, defaultConfig, loadConfig } from "./config.ts";
import { detectGates } from "./initgen.ts";
import { acquireLock } from "./lock.ts";
import { readVerdict, renderHuman, writeVerdict } from "./report.ts";
import { exitCodeFor, runPipeline, spawnExecutor } from "./runner.ts";
import { fileExists, writeTextFile } from "./runtime.ts";
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
  noCache: boolean;
  changed: boolean;
}

export async function cmdRun(
  flags: RunFlags,
  opts: { skipLock?: boolean } = {},
): Promise<number> {
  let config: HyperfixerConfig;
  try {
    config = await loadConfig(flags.configPath);
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  // Fingerprint the pristine gate set: hint recomputes from the full config,
  // so a filtered run (--only, --max-cost) must not look stale by construction.
  const pristineGates = config.gates;
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
  if (flags.changed) {
    const files = changedFiles();
    if (files === null) {
      console.error(red("--changed requires a git repository"));
      return 2;
    }
    config.gates = applyChanged(config.gates, files);
  }

  const lock = opts.skipLock ? null : acquireLock(config.outDir);
  if (lock !== null && !lock.ok) {
    console.error(
      red(
        `another hyperfixer run is in progress${lock.holderPid !== null ? ` (pid ${lock.holderPid})` : ""}, wait for it or delete ${config.outDir}/lock if stale`,
      ),
    );
    return 2;
  }
  try {
    const fingerprint = pipelineFingerprint(pristineGates);
    const cache = flags.noCache ? null : await loadCache(config.outDir);
    const exec = cache === null ? spawnExecutor : cachingExecutor(spawnExecutor, cache);
    const verdict = await runPipeline(config, exec);
    if (fingerprint !== null) verdict.inputsFingerprint = fingerprint;
    if (cache !== null) await saveCache(config.outDir, cache);
    const path = await writeVerdict(verdict, config.outDir);
    if (flags.json) {
      console.log(JSON.stringify(verdict, null, 2));
    } else if (!flags.quiet) {
      console.log(renderHuman(verdict));
      console.log(dim(`verdict: ${path}`));
    }
    return exitCodeFor(verdict);
  } finally {
    if (lock?.ok) lock.release();
  }
}

export async function cmdInit(): Promise<number> {
  if (fileExists(CONFIG_FILE)) {
    console.error(`${CONFIG_FILE} already exists, not overwriting`);
    return 2;
  }
  const { gates, detected } = detectGates();
  const config: HyperfixerConfig = { ...defaultConfig(), gates };
  writeTextFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    detected.length > 0
      ? `detected: ${detected.join(", ")}`
      : "nothing detected, using default gates",
  );
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
  // Content beats clock: when the verdict carries an inputs fingerprint,
  // recompute it and warn only on a real change. Clock is the fallback.
  if (verdict.inputsFingerprint !== undefined) {
    if (pipelineFingerprint(config.gates) !== verdict.inputsFingerprint) {
      console.error(
        'warning: inputs changed since this verdict, re-run "hyperfixer run"',
      );
    }
  } else {
    const ageMs = Date.now() - Date.parse(verdict.generatedAt ?? "");
    if (!Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS) {
      console.error('warning: verdict may be stale, re-run "hyperfixer run"');
    }
  }
  console.log(
    verdict.ok ? "OK, nothing to fix" : (verdict.hint ?? "FAIL, see verdict.json"),
  );
  return exitCodeFor(verdict);
}
