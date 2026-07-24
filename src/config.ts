import { fileExists, readTextFile } from "./runtime.ts";
import type { GateSpec, HyperfixerConfig, ParserKind } from "./types.ts";

export const CONFIG_FILE = "hyperfixer.config.json";

/**
 * Default pipeline, ordered by cost. Layers map to verification strata:
 * lint -> typecheck (L0) -> type tests (L1) -> unit (L2) -> property-based
 * (L3) -> differential/parity (L4) -> mutation (L5).
 */
export const DEFAULT_GATES: GateSpec[] = [
  {
    name: "lint",
    cost: 5,
    // Scoped package name on purpose: bare "biome" on npm is an unrelated
    // abandoned package that exits 0 without linting, so a project without a
    // local install would get a lint gate that always passes.
    command: ["bunx", "@biomejs/biome", "check", "."],
    parser: "raw",
    optional: true,
  },
  {
    name: "typecheck",
    cost: 10,
    command: ["bunx", "tsc", "--noEmit", "--pretty", "false"],
    parser: "tsc",
  },
  {
    name: "typetest",
    cost: 20,
    command: ["bun", "test", "test/types"],
    parser: "bun-test",
    optional: true,
    enabled: false,
  },
  { name: "unit", cost: 30, command: ["bun", "test"], parser: "bun-test" },
  {
    name: "pbt",
    cost: 40,
    command: ["bun", "test", "test/property"],
    parser: "bun-test",
    optional: true,
    enabled: false,
  },
  { name: "parity", cost: 50, optional: true, enabled: false },
  {
    name: "mutation",
    cost: 100,
    command: ["bunx", "@stryker-mutator/core", "run", "--incremental"],
    parser: "raw",
    optional: true,
    enabled: false,
  },
];

export function defaultConfig(): HyperfixerConfig {
  return { gates: DEFAULT_GATES, failFast: true, outDir: ".hyperfixer" };
}

/**
 * Load the config. When the caller named the path explicitly (--config), a
 * missing file is a setup error: silently falling back to the built in gates
 * would run a different pipeline than the one asked for and report it green.
 */
export async function loadConfig(
  path = CONFIG_FILE,
  explicit = false,
): Promise<HyperfixerConfig> {
  if (!fileExists(path)) {
    if (explicit) throw new Error(`${path}: config file not found`);
    return defaultConfig();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readTextFile(path));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return normalizeConfig(raw, path);
}

export function normalizeConfig(raw: unknown, source: string): HyperfixerConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: config must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const base = defaultConfig();
  const gates = Array.isArray(obj.gates)
    ? obj.gates.map((g, i) => normalizeGate(g, `${source}: gates[${i}]`))
    : base.gates;
  const seen = new Set<string>();
  for (const g of gates) {
    if (seen.has(g.name)) {
      throw new Error(`${source}: duplicate gate name "${g.name}"`);
    }
    seen.add(g.name);
  }
  return {
    gates,
    failFast: typeof obj.failFast === "boolean" ? obj.failFast : base.failFast,
    outDir: typeof obj.outDir === "string" ? obj.outDir : base.outDir,
  };
}

const PARSER_KINDS = [
  "tsc",
  "bun-test",
  "fast-check",
  "eslint-json",
  "findings-json",
  "raw",
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Every present field is validated and a bad one throws. Ignoring a malformed
 * field would leave the gate without a command, and a gate without a command
 * is skipped, so a typo in the config would quietly turn verification off and
 * still report the run green.
 */
function normalizeGate(raw: unknown, source: string): GateSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: gate must be an object`);
  }
  const g = raw as Record<string, unknown>;
  if (typeof g.name !== "string" || g.name.length === 0) {
    throw new Error(`${source}: gate needs a non-empty "name"`);
  }
  const where = `${source}: gate "${g.name}"`;
  if (typeof g.cost !== "number" || !Number.isFinite(g.cost)) {
    throw new Error(`${where} needs a numeric "cost"`);
  }
  const spec: GateSpec = { name: g.name, cost: g.cost };
  for (const key of ["command", "fixCommand", "inputs"] as const) {
    const value = g[key];
    if (value === undefined) continue;
    if (!isStringArray(value)) {
      throw new Error(`${where}: "${key}" must be an array of strings`);
    }
    spec[key] = value;
  }
  for (const key of ["optional", "enabled"] as const) {
    const value = g[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean")
      throw new Error(`${where}: "${key}" must be a boolean`);
    spec[key] = value;
  }
  if (g.parser !== undefined) {
    const kinds: readonly string[] = PARSER_KINDS;
    if (typeof g.parser !== "string" || !kinds.includes(g.parser)) {
      throw new Error(`${where}: "parser" must be one of ${PARSER_KINDS.join(", ")}`);
    }
    spec.parser = g.parser as ParserKind;
  }
  if (g.timeoutMs !== undefined) {
    if (
      typeof g.timeoutMs !== "number" ||
      !Number.isFinite(g.timeoutMs) ||
      g.timeoutMs <= 0
    ) {
      throw new Error(`${where}: "timeoutMs" must be a positive number`);
    }
    spec.timeoutMs = g.timeoutMs;
  }
  return spec;
}
