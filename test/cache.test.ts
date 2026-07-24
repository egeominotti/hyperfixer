import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheFile } from "../src/cache.ts";
import { cachingExecutor, gateHash, loadCache } from "../src/cache.ts";
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

  test("hash changes when the command changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cachecmd-"));
    try {
      await Bun.write(join(dir, "a.ts"), "export {}");
      const base: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.ts"] };
      const other: GateSpec = { ...base, command: ["false"] };
      expect(gateHash(base, dir)).not.toBe(gateHash(other, dir) as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Hashing the empty set would yield a constant digest that can never
  // change, so the first pass would be replayed forever.
  test("inputs matching no file are not hashable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cachenone-"));
    try {
      await Bun.write(join(dir, "a.ts"), "export {}");
      mkdirSync(join(dir, "sub"));
      const gate = (inputs: string[]): GateSpec => ({
        name: "g",
        cost: 1,
        command: ["true"],
        inputs,
      });
      // brace expansion is not supported, so this pattern matches nothing
      expect(gateHash(gate(["*.{ts,tsx}"]), dir)).toBeNull();
      expect(gateHash(gate(["missing/**"]), dir)).toBeNull();
      // a directory has no content to hash
      expect(gateHash(gate(["sub"]), dir)).toBeNull();
      expect(gateHash(gate(["*.ts"]), dir)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hash stream is injective: content cannot impersonate another file", async () => {
    const two = mkdtempSync(join(tmpdir(), "hyperfixer-cache2-"));
    const one = mkdtempSync(join(tmpdir(), "hyperfixer-cache1-"));
    try {
      await Bun.write(join(two, "a.ts"), "1");
      await Bun.write(join(two, "b.ts"), "2");
      // the same byte stream, folded into a single file
      await Bun.write(join(one, "a.ts"), "1b.ts 2");
      const gate: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.ts"] };
      expect(gateHash(gate, two)).not.toBe(gateHash(gate, one) as string);
    } finally {
      rmSync(two, { recursive: true, force: true });
      rmSync(one, { recursive: true, force: true });
    }
  });
});

describe("loadCache", () => {
  test("entries that are not a GateResult are dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cacheload-"));
    try {
      const good = {
        gate: "good",
        status: "pass",
        durationMs: 1,
        exitCode: 0,
        findings: [],
        outputTail: "",
      };
      await Bun.write(
        join(dir, "cache.json"),
        JSON.stringify({
          good: { hash: "h", result: good },
          missingFields: { hash: "h", result: { status: "pass" } },
          badStatus: { hash: "h", result: { ...good, status: "green" } },
          noHash: { result: good },
        }),
      );
      expect(Object.keys(await loadCache(dir))).toEqual(["good"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  // Without the hash comparison every gate would be a permanent cache hit
  // after its first pass, which is the worst false green this tool can emit.
  test("a stale entry is not a hit: changed inputs re-run the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-cachestale-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      await Bun.write("src.ts", "export {}");
      const gate: GateSpec = { name: "g", cost: 1, command: ["true"], inputs: ["*.ts"] };
      const counter = { calls: 0 };
      const cache: CacheFile = {};
      const exec = cachingExecutor(passExec(counter), cache);

      await exec(gate);
      await Bun.write("src.ts", "export const changed = 1;");
      const after = await exec(gate);
      expect(after.cached).toBeUndefined();
      expect(counter.calls).toBe(2);
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
