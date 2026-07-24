import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";
import { writeTextFile } from "../src/runtime.ts";

describe("acquireLock", () => {
  test("acquire, contend, release, reacquire", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lock-"));
    try {
      const first = acquireLock(dir);
      expect(first.ok).toBe(true);

      const second = acquireLock(dir);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.holderPid).toBe(process.pid);

      if (first.ok) first.release();
      const third = acquireLock(dir);
      expect(third.ok).toBe(true);
      if (third.ok) third.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale lock from a dead pid is stolen", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lockstale-"));
    try {
      writeTextFile(
        join(dir, "lock"),
        JSON.stringify({ pid: 999_999_997, at: Date.now() }),
      );
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt lock file is stolen", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lockbad-"));
    try {
      writeTextFile(join(dir, "lock"), "not json");
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
