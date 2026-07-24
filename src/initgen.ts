import { DEFAULT_GATES } from "./config.ts";
import { withInputs } from "./inputs.ts";
import { fileExists, readTextFile } from "./runtime.ts";
import type { GateSpec } from "./types.ts";

function anyOf(...paths: string[]): boolean {
  return paths.some((p) => fileExists(p));
}

function testScript(): boolean {
  try {
    const pkg = JSON.parse(readTextFile("package.json")) as {
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

export function detectGates(): DetectedConfig {
  const gates: GateSpec[] = [];
  const detected: string[] = [];
  const isBun = anyOf("bun.lock", "bun.lockb", "bunfig.toml");
  const x = isBun ? "bunx" : "npx";

  if (anyOf("biome.json", "biome.jsonc")) {
    gates.push(
      withInputs(
        {
          name: "lint",
          cost: 5,
          // Scoped name: bare "biome" on npm is an unrelated abandoned
          // package that exits 0 without linting, so the gate always passes.
          command: [x, "@biomejs/biome", "check", "."],
          fixCommand: [x, "@biomejs/biome", "check", "--write", "."],
          parser: "raw",
        },
        ["biome.json", "biome.jsonc"],
      ),
    );
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
    gates.push(
      withInputs({
        name: "lint",
        cost: 5,
        command: [x, "eslint", ".", "--format", "json"],
        fixCommand: [x, "eslint", ".", "--fix"],
        parser: "eslint-json",
      }),
    );
    detected.push("eslint");
  }

  if (fileExists("tsconfig.json")) {
    gates.push(
      withInputs(
        {
          name: "typecheck",
          cost: 10,
          command: [x, "tsc", "--noEmit", "--pretty", "false"],
          parser: "tsc",
        },
        ["tsconfig.json"],
      ),
    );
    detected.push("typescript");
  }

  // One unit gate covering the whole suite: bun test has no exclude, so
  // per-directory gates would run the same tests twice.
  if (isBun) {
    gates.push(
      withInputs({
        name: "unit",
        cost: 30,
        command: ["bun", "test"],
        parser: "bun-test",
      }),
    );
    detected.push("bun test");
  } else if (anyOf("vitest.config.ts", "vitest.config.js", "vitest.config.mts")) {
    gates.push(
      withInputs({
        name: "unit",
        cost: 30,
        command: [x, "vitest", "run"],
        parser: "raw",
      }),
    );
    detected.push("vitest");
  } else if (testScript()) {
    gates.push(
      withInputs({ name: "unit", cost: 30, command: ["npm", "test"], parser: "raw" }),
    );
    detected.push("npm test script");
  }

  // Reaching the fallback means nothing was detected, and a bun project always
  // contributes its unit gate, so this branch is a project without bun.
  if (gates.length === 0) return { gates: forNpx(DEFAULT_GATES), detected: [] };
  gates.sort((a, b) => a.cost - b.cost);
  return { gates, detected };
}

/**
 * DEFAULT_GATES speak bun. Handing them unchanged to a project without bun
 * writes a config whose enabled commands fail to spawn, which the pipeline
 * reports as exit 3 on the very first run. Only the enabled gates have an npm
 * equivalent; the bun-only test gates ship disabled and stay untouched.
 */
function forNpx(gates: GateSpec[]): GateSpec[] {
  const swap = (argv: string[] | undefined): string[] | undefined => {
    if (argv === undefined) return undefined;
    const [head, ...rest] = argv;
    if (head === "bunx") return ["npx", ...rest];
    if (head === "bun" && rest.length === 1 && rest[0] === "test") return ["npm", "test"];
    return argv;
  };
  return gates.map((g) => {
    const command = swap(g.command);
    const fixCommand = swap(g.fixCommand);
    return {
      ...g,
      ...(command === undefined ? {} : { command }),
      ...(fixCommand === undefined ? {} : { fixCommand }),
    };
  });
}
