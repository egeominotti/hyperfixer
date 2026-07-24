import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";
import { fileExists, writeTextFile } from "../src/runtime.ts";

/** Backdate a file so age-based judgements see it as a leftover. */
function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

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

  test("release after our lock was stolen never deletes the new holder's lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lockown-"));
    try {
      const ours = acquireLock(dir);
      expect(ours.ok).toBe(true);
      // A foreign run replaces our lock (as after a steal).
      writeTextFile(
        join(dir, "lock"),
        JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "foreign" }),
      );
      if (ours.ok) ours.release();
      // The foreign lock must survive our release: acquire must still fail.
      const contender = acquireLock(dir);
      expect(contender.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Age alone must not condemn a lock: the mutation gate can legitimately run
  // for ten minutes, and dispossessing it would let a second run start on the
  // same outDir and overwrite its verdict.
  test("a live holder is never stolen, however old the lock is", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lockold-"));
    try {
      writeTextFile(
        join(dir, "lock"),
        JSON.stringify({
          pid: process.pid,
          at: Date.now() - 60 * 60_000,
          nonce: "old-but-alive",
        }),
      );
      const result = acquireLock(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.holderPid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock with no readable pid is stolen once it ages out", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-locknopid-"));
    try {
      writeTextFile(join(dir, "lock"), JSON.stringify({ at: Date.now() - 60 * 60_000 }));
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A lock can be empty: written by hand, or created by a filesystem with no
  // hard links where publishing takes two syscalls. Judging one by content
  // would let a contender steal it from a run that is starting right now.
  test("a fresh unreadable lock is left alone, an old one is stolen", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-lockbad-"));
    try {
      const path = join(dir, "lock");
      for (const content of ["", "not json", "{}"]) {
        writeTextFile(path, content);
        const fresh = acquireLock(dir);
        expect(fresh.ok).toBe(false);
        if (fresh.ok) fresh.release();
      }
      // The same file, old enough that no writer can still be mid create.
      age(path, 60_000);
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("steal guard", () => {
  const staleLock = (dir: string) =>
    writeTextFile(
      join(dir, "lock"),
      JSON.stringify({ pid: 999_999_997, at: Date.now(), nonce: "dead" }),
    );

  test("a fresh guard means another stealer is working: back off", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-guard-"));
    try {
      staleLock(dir);
      writeTextFile(join(dir, "lock.steal"), JSON.stringify({ pid: process.pid }));
      const result = acquireLock(dir);
      expect(result.ok).toBe(false);
      // The other stealer's guard and the lock it is judging both survive.
      expect(fileExists(join(dir, "lock.steal"))).toBe(true);
      expect(fileExists(join(dir, "lock"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Same reasoning as the lock: an empty guard is a live contender, not a
  // leftover, so only its age may condemn it.
  test("an empty guard is treated as live, not abandoned", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-guardempty-"));
    try {
      staleLock(dir);
      writeTextFile(join(dir, "lock.steal"), "");
      expect(acquireLock(dir).ok).toBe(false);
      expect(fileExists(join(dir, "lock.steal"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A process that died between creating the guard and releasing it must not
  // block every later run, and clearing it must not cost the whole acquire.
  test("an abandoned guard is cleared and the lock still acquired", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-guardold-"));
    try {
      staleLock(dir);
      const guard = join(dir, "lock.steal");
      writeTextFile(guard, JSON.stringify({ pid: 999_999_997 }));
      age(guard, 60_000);
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      expect(fileExists(guard)).toBe(false);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a successful steal leaves no guard behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-guardclean-"));
    try {
      staleLock(dir);
      const result = acquireLock(dir);
      expect(result.ok).toBe(true);
      expect(fileExists(join(dir, "lock.steal"))).toBe(false);
      if (result.ok) result.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
