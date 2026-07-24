import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishExclusive,
  readTextFile,
  spawnCapture,
  writeTextFileExclusive,
} from "../src/runtime.ts";

function failing(code: string): (from: string, to: string) => void {
  return () => {
    throw Object.assign(new Error(`link ${code}`), { code });
  };
}

describe("writeTextFileExclusive", () => {
  test("creates once, refuses a second time, leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-excl-"));
    try {
      const path = join(dir, "lock");
      expect(writeTextFileExclusive(path, "first\n")).toBe(true);
      expect(writeTextFileExclusive(path, "second\n")).toBe(false);
      expect(readTextFile(path)).toBe("first\n");
      expect(readdirSync(dir)).toEqual(["lock"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A filesystem with no hard links (FAT, some network mounts) must not leave
  // the tool unable to lock at all, which would break it permanently.
  test("falls back to an exclusive open where hard links are unsupported", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-nolink-"));
    try {
      const path = join(dir, "lock");
      for (const code of ["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]) {
        rmSync(path, { force: true });
        expect(publishExclusive(path, `via ${code}\n`, failing(code))).toBe(true);
        expect(readTextFile(path)).toBe(`via ${code}\n`);
        // Still exclusive: the fallback must not overwrite an existing file.
        expect(publishExclusive(path, "second\n", failing(code))).toBe(false);
        expect(readTextFile(path)).toBe(`via ${code}\n`);
        expect(readdirSync(dir)).toEqual(["lock"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Any other link failure is a real problem, not a missing feature: falling
  // back there would paper over a filesystem that cannot be trusted.
  test("other link failures are not papered over", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-linkerr-"));
    try {
      const path = join(dir, "lock");
      expect(publishExclusive(path, "x\n", failing("EIO"))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnCapture process-group kill", () => {
  test("SIGTERM-ignoring child with grandchildren is bounded by the timeout", async () => {
    const start = performance.now();
    const res = await spawnCapture(["sh", "-c", "trap '' TERM; sleep 30 & sleep 30"], {
      timeoutMs: 150,
      killGraceMs: 150,
    });
    const elapsed = performance.now() - start;
    expect(res.timedOut).toBe(true);
    // Previously this hung for the full 30s because orphaned grandchildren
    // kept the pipes open. Group SIGKILL must bound it near timeout + grace.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  // close fires only once every inherited pipe closes too, so a child that
  // exits while a backgrounded grandchild still holds stdout used to run past
  // its timeout unbounded.
  test("child exiting while a grandchild holds the pipe still times out", async () => {
    const start = performance.now();
    const res = await spawnCapture(["sh", "-c", "sleep 30 & exit 0"], {
      timeoutMs: 200,
      killGraceMs: 150,
    });
    expect(res.timedOut).toBe(true);
    expect(performance.now() - start).toBeLessThan(5_000);
  }, 10_000);

  // A grandchild that escapes the process group keeps the pipe open, and
  // close waits for every inherited pipe, so without a hard bound the timeout
  // is only a suggestion and the run holds the repo lock meanwhile.
  test("a grandchild outside the process group cannot outlast the bound", async () => {
    const start = performance.now();
    const res = await spawnCapture(["sh", "-c", "(sleep 20 &); exit 0"], {
      timeoutMs: 200,
      killGraceMs: 150,
    });
    expect(res.timedOut).toBe(true);
    expect(performance.now() - start).toBeLessThan(3_000);
  }, 25_000);

  test("output past the cap is dropped and flagged, not accumulated", async () => {
    // A producer that ends on its own: one relying on SIGPIPE to stop can
    // outlive the pipeline when it wins the race against its reader.
    const res = await spawnCapture(
      ["sh", "-c", "head -c 40000000 /dev/zero | tr '\\0' 'a'"],
      { timeoutMs: 60_000, killGraceMs: 500 },
    );
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(res.exitCode).toBe(0);
  }, 60_000);

  test("a child killed by a signal reports which signal", async () => {
    const res = await spawnCapture(["sh", "-c", "kill -TERM $$"], {
      timeoutMs: 5_000,
      killGraceMs: 100,
    });
    expect(res.timedOut).toBe(false);
    expect(res.signal).toBe("SIGTERM");
  });

  test("utf-8 characters split across writes decode intact", async () => {
    const res = await spawnCapture(
      ["sh", "-c", "printf '\\342\\202'; sleep 0.05; printf '\\254 done'"],
      { timeoutMs: 5_000, killGraceMs: 100 },
    );
    expect(res.stdout).toBe("€ done");
  });
});
