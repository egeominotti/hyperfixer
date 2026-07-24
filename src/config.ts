import type { GateSpec, HyperfixerConfig } from "./types.ts";

export const CONFIG_FILE = "hyperfixer.config.json";

/**
 * Default pipeline, ordered by cost. Layers map to verification strata:
 * typecheck (L0) -> type tests (L1) -> unit (L2) -> property-based (L3)
 * -> differential/parity (L4) -> mutation (L5).
 */
export const DEFAULT_GATES: GateSpec[] = [
  {
    name: "lint",
    cost: 5,
    command: ["bunx", "biome", "check", "."],
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
    command: ["bunx", "stryker", "run", "--incremental"],
    parser: "raw",
    optional: true,
    enabled: false,
  },
];

export function defaultConfig(): HyperfixerConfig {
  return { gates: DEFAULT_GATES, failFast: true, outDir: ".hyperfixer" };
}

export async function loadConfig(path = CONFIG_FILE): Promise<HyperfixerConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultConfig();
  const raw: unknown = await file.json();
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

function normalizeGate(raw: unknown, source: string): GateSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: gate must be an object`);
  }
  const g = raw as Record<string, unknown>;
  if (typeof g.name !== "string" || g.name.length === 0) {
    throw new Error(`${source}: gate needs a non-empty "name"`);
  }
  if (typeof g.cost !== "number" || !Number.isFinite(g.cost)) {
    throw new Error(`${source}: gate "${g.name}" needs a numeric "cost"`);
  }
  const spec: GateSpec = { name: g.name, cost: g.cost };
  if (Array.isArray(g.command) && g.command.every((c) => typeof c === "string")) {
    spec.command = g.command;
  }
  if (typeof g.optional === "boolean") spec.optional = g.optional;
  if (typeof g.enabled === "boolean") spec.enabled = g.enabled;
  if (
    g.parser === "tsc" ||
    g.parser === "bun-test" ||
    g.parser === "fast-check" ||
    g.parser === "raw"
  ) {
    spec.parser = g.parser;
  }
  if (typeof g.timeoutMs === "number" && g.timeoutMs > 0) {
    spec.timeoutMs = g.timeoutMs;
  }
  if (Array.isArray(g.inputs) && g.inputs.every((p) => typeof p === "string")) {
    spec.inputs = g.inputs;
  }
  return spec;
}
