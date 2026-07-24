import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheFile } from "../src/cache.ts";
import { cachingExecutor, gateHash } from "../src/cache.ts";
import type { GateExecutor, GateSpec } from "../src/types.ts";

function passExec(counter: { calls: number }): GateExecutor {
  return async (g) => {
    counter.calls++;
    return {
      gate: g.name,
      status: "pass",
      durationMs: 5,
      exitCode: 0,
      findings: [],
      outputTail: "",
    };
  };
}

describe("gateHash", () => {
  test("gate without inputs is never hashable", () => {
    expect(gateHash({ name: "a", cost: 1, command: ["true"] })).toBeNull();
  });

  test("hash is content-based: touch is stable, content change invalidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cache-"));
    try {
      await Bun.write(join(dir, "a.ts"), "export {}");
      const gate: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.ts"] };
      const h1 = gateHash(gate, dir);
      expect(gateHash(gate, dir)).toBe(h1 as string);
      // mtime-only change (touch, git checkout rewriting identical bytes) must NOT invalidate
      utimesSync(join(dir, "a.ts"), new Date(), new Date(Date.now() + 5000));
      expect(gateHash(gate, dir)).toBe(h1 as string);
      // real content change must invalidate
      await Bun.write(join(dir, "a.ts"), "export const x = 1;");
      expect(gateHash(gate, dir)).not.toBe(h1 as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hash changes when the command changes", () => {
    const base: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.zzz"] };
    const other: GateSpec = { ...base, command: ["false"] };
    expect(gateHash(base)).not.toBe(gateHash(other) as string);
  });
});

describe("cachingExecutor", () => {
  test("second run with unchanged inputs is a cache hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cachex-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      await Bun.write("src.ts", "export {}");
      const gate: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.ts"] };
      const counter = { calls: 0 };
      const cache: CacheFile = {};
      const exec = cachingExecutor(passExec(counter), cache);

      const first = await exec(gate);
      expect(first.cached).toBeUndefined();
      const second = await exec(gate);
      expect(second.cached).toBe(true);
      expect(second.status).toBe("pass");
      expect(counter.calls).toBe(1);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failure is never cached", async () => {
    const gate: GateSpec = { name: "g", cost: 1, command: ["x"], inputs: ["*.none"] };
    const cache: CacheFile = {};
    const failing: GateExecutor = async (g) => ({
      gate: g.name,
      status: "fail",
      durationMs: 1,
      exitCode: 1,
      findings: [],
      outputTail: "",
    });
    const exec = cachingExecutor(failing, cache);
    await exec(gate);
    expect(cache.g).toBeUndefined();
  });

  test("gate without inputs always re-runs", async () => {
    const gate: GateSpec = { name: "g", cost: 1, command: ["true"] };
    const counter = { calls: 0 };
    const exec = cachingExecutor(passExec(counter), {});
    await exec(gate);
    await exec(gate);
    expect(counter.calls).toBe(2);
  });
});
