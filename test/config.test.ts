import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, normalizeConfig } from "../src/config.ts";
import { globSync } from "../src/glob.ts";

function gates(...gs: unknown[]): unknown {
  return { gates: gs };
}

describe("loadConfig", () => {
  test("no config at the default path falls back to the built-in gates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cfg-"));
    try {
      const config = await loadConfig(join(dir, "hyperfixer.config.json"));
      expect(config.gates.map((g) => g.name)).toEqual(
        defaultConfig().gates.map((g) => g.name),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Silently running a different pipeline than the one the user named would
  // report a green verdict for gates that never ran.
  test("an explicitly named config that does not exist is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cfgx-"));
    try {
      const missing = join(dir, "typo.json");
      await expect(loadConfig(missing, true)).rejects.toThrow("config file not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The unit gate names its test files one by one, so a new test/*.test.ts is
// silently unverified until someone remembers to add it. That is exactly the
// kind of quiet green this tool exists to prevent, in this tool's own config.
describe("this repo's own config", () => {
  test("the unit gate runs every test/*.test.ts", async () => {
    const config = await loadConfig();
    const unit = config.gates.find((g) => g.name === "unit");
    const listed = new Set(unit?.command?.filter((a) => a.endsWith(".test.ts")) ?? []);
    const onDisk = globSync("test/*.test.ts");
    expect(onDisk.length).toBeGreaterThan(0);
    expect([...onDisk].filter((f) => !listed.has(f))).toEqual([]);
  });

  // The guards below only run when the unit gate's key sees what they read.
  // Drop one of these and the guards go quietly blind, which is the exact
  // failure they exist to catch, so assert the precondition itself.
  test("the unit gate's key covers everything the guards read", async () => {
    const config = await loadConfig();
    const inputs = config.gates.find((g) => g.name === "unit")?.inputs ?? [];
    const referenced = new Set(
      config.gates.flatMap((g) => (g.inputs ?? []).filter((p) => !p.includes("*"))),
    );
    for (const file of ["hyperfixer.config.json", ...referenced]) {
      expect([file, inputs.includes(file)]).toEqual([file, true]);
    }
  });

  test("every gate's declared inputs resolve to at least one file", async () => {
    const config = await loadConfig();
    for (const gate of config.gates.filter((g) => g.enabled !== false)) {
      for (const pattern of gate.inputs ?? []) {
        expect([pattern, globSync(pattern).length > 0]).toEqual([pattern, true]);
      }
    }
  });
});

describe("normalizeConfig gate validation", () => {
  const bad = (raw: unknown, message: string) => {
    expect(() => normalizeConfig(raw, "cfg")).toThrow(message);
  };

  // A malformed field used to be ignored, which left the gate without a
  // command, and a gate without a command is skipped, not failed.
  test("command, fixCommand and inputs must be arrays of strings", () => {
    bad(gates({ name: "unit", cost: 1, command: "bun test" }), '"command" must be');
    bad(gates({ name: "unit", cost: 1, command: ["bun", 3] }), '"command" must be');
    bad(gates({ name: "unit", cost: 1, fixCommand: "fix" }), '"fixCommand" must be');
    bad(gates({ name: "unit", cost: 1, inputs: "src/**" }), '"inputs" must be');
  });

  test("parser must be a known kind", () => {
    bad(gates({ name: "unit", cost: 1, parser: "jest" }), '"parser" must be one of');
  });

  test("optional and enabled must be booleans", () => {
    bad(
      gates({ name: "unit", cost: 1, optional: "yes" }),
      '"optional" must be a boolean',
    );
    bad(gates({ name: "unit", cost: 1, enabled: 0 }), '"enabled" must be a boolean');
  });

  test("timeoutMs must be a positive number", () => {
    bad(gates({ name: "unit", cost: 1, timeoutMs: 0 }), '"timeoutMs" must be');
    bad(gates({ name: "unit", cost: 1, timeoutMs: "5s" }), '"timeoutMs" must be');
  });

  test("a gate with no command at all stays legal, it is a placeholder", () => {
    const config = normalizeConfig(gates({ name: "parity", cost: 1 }), "cfg");
    expect(config.gates[0]?.command).toBeUndefined();
  });

  test("valid fields survive normalization", () => {
    const config = normalizeConfig(
      gates({
        name: "unit",
        cost: 30,
        command: ["bun", "test"],
        parser: "bun-test",
        inputs: ["src/**"],
        optional: false,
        timeoutMs: 1000,
      }),
      "cfg",
    );
    expect(config.gates[0]).toEqual({
      name: "unit",
      cost: 30,
      command: ["bun", "test"],
      parser: "bun-test",
      inputs: ["src/**"],
      optional: false,
      timeoutMs: 1000,
    });
  });
});
