import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_GATES } from "./config.ts";
import type { GateSpec } from "./types.ts";

function anyOf(...paths: string[]): boolean {
  return paths.some((p) => existsSync(p));
}

function testScript(): boolean {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
}

export interface DetectedConfig {
  gates: GateSpec[];
  detected: string[];
}

/** Inspect the project and build a tailored gate list. Falls back to defaults. */
const SRC_INPUTS = ["src/**", "test/**"];

export function detectGates(): DetectedConfig {
  const gates: GateSpec[] = [];
  const detected: string[] = [];
  const isBun = anyOf("bun.lock", "bun.lockb", "bunfig.toml");
  const x = isBun ? "bunx" : "npx";

  if (anyOf("biome.json", "biome.jsonc")) {
    gates.push({
      name: "lint",
      cost: 5,
      command: [x, "biome", "check", "."],
      parser: "raw",
      inputs: [...SRC_INPUTS, "biome.json", "biome.jsonc"],
    });
    detected.push("biome");
  } else if (
    anyOf(
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.cjs",
    )
  ) {
    gates.push({
      name: "lint",
      cost: 5,
      command: [x, "eslint", "."],
      parser: "raw",
      inputs: SRC_INPUTS,
    });
    detected.push("eslint");
  }

  if (existsSync("tsconfig.json")) {
    gates.push({
      name: "typecheck",
      cost: 10,
      command: [x, "tsc", "--noEmit", "--pretty", "false"],
      parser: "tsc",
      inputs: [...SRC_INPUTS, "tsconfig.json"],
    });
    detected.push("typescript");
  }

  // One unit gate covering the whole suite: bun test has no exclude, so
  // per-directory gates would run the same tests twice.
  if (isBun) {
    gates.push({
      name: "unit",
      cost: 30,
      command: ["bun", "test"],
      parser: "bun-test",
      inputs: SRC_INPUTS,
    });
    detected.push("bun test");
  } else if (anyOf("vitest.config.ts", "vitest.config.js", "vitest.config.mts")) {
    gates.push({
      name: "unit",
      cost: 30,
      command: [x, "vitest", "run"],
      parser: "raw",
      inputs: SRC_INPUTS,
    });
    detected.push("vitest");
  } else if (testScript()) {
    gates.push({
      name: "unit",
      cost: 30,
      command: ["npm", "test"],
      parser: "raw",
      inputs: SRC_INPUTS,
    });
    detected.push("npm test script");
  }

  if (gates.length === 0) return { gates: DEFAULT_GATES, detected: [] };
  gates.sort((a, b) => a.cost - b.cost);
  return { gates, detected };
}
