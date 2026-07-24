import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli.ts");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function writeConfig(dir: string, gates: unknown[]): Promise<number> {
  const config = { failFast: true, outDir: ".hyperfixer", gates };
  return Bun.write(join(dir, "hyperfixer.config.json"), JSON.stringify(config));
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperfixer-e2e-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("e2e: run", () => {
  test("all gates pass: exit 0, valid verdict.json", async () => {
    await writeConfig(dir, [
      { name: "a", cost: 1, command: ["true"] },
      { name: "b", cost: 2, command: ["true"] },
    ]);
    const r = await cli(dir, "run", "--quiet");
    expect(r.exitCode).toBe(0);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.ok).toBe(true);
    expect(verdict.failedGate).toBeNull();
    expect(Date.parse(verdict.generatedAt)).toBeGreaterThan(0);
  });

  test("failing gate: exit 1, fail-fast skips the rest", async () => {
    await writeConfig(dir, [
      { name: "a", cost: 1, command: ["true"] },
      { name: "b", cost: 2, command: ["false"] },
      { name: "c", cost: 3, command: ["true"] },
    ]);
    const r = await cli(dir, "run", "--quiet");
    expect(r.exitCode).toBe(1);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.failedGate).toBe("b");
    expect(verdict.gates.map((g: { status: string }) => g.status)).toEqual([
      "pass",
      "fail",
      "skip",
    ]);
  });

  test("--json prints parseable verdict on stdout", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    const r = await cli(dir, "run", "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  test("--max-cost filters expensive gates out of the pipeline", async () => {
    await writeConfig(dir, [
      { name: "cheap", cost: 1, command: ["true"] },
      { name: "pricey", cost: 99, command: ["false"] },
    ]);
    const r = await cli(dir, "run", "--quiet", "--max-cost", "50");
    expect(r.exitCode).toBe(0);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.gates.map((g: { gate: string }) => g.gate)).toEqual(["cheap"]);
  });

  test("--max-cost excluding every gate: exit 2 setup problem, never a false OK", async () => {
    await writeConfig(dir, [{ name: "a", cost: 10, command: ["true"] }]);
    const r = await cli(dir, "run", "--quiet", "--max-cost", "1");
    expect(r.exitCode).toBe(2);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toContain("no gates executed");
  });

  test("timed-out gate: exit 3 infrastructure, distinct from code failure", async () => {
    await writeConfig(dir, [
      { name: "hang", cost: 1, command: ["sleep", "10"], timeoutMs: 100 },
    ]);
    const r = await cli(dir, "run", "--quiet");
    expect(r.exitCode).toBe(3);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.gates[0].status).toBe("error");
  });

  test("fix runs fixCommand then verifies green", async () => {
    const marker = join(dir, "fixed.txt");
    await writeConfig(dir, [
      {
        name: "needs-fix",
        cost: 1,
        command: ["test", "-f", marker],
        fixCommand: ["sh", "-c", `printf ok > ${marker}`],
      },
    ]);
    expect((await cli(dir, "run", "--quiet")).exitCode).toBe(1);
    const r = await cli(dir, "fix", "--quiet");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("fix needs-fix");
  });

  test("fix refuses to run fixers while another run holds the lock", async () => {
    const marker = join(dir, "should-not-exist.txt");
    await writeConfig(dir, [
      {
        name: "g",
        cost: 1,
        command: ["true"],
        fixCommand: ["sh", "-c", `printf no > ${marker}`],
      },
    ]);
    await Bun.write(
      join(dir, ".hyperfixer/lock"),
      JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "held" }),
    );
    const r = await cli(dir, "fix", "--quiet");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("another hyperfixer run is in progress");
    expect(await Bun.file(marker).exists()).toBe(false);
    rmSync(join(dir, ".hyperfixer/lock"), { force: true });
  });

  test("--only with unknown gate: exit 2", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    const r = await cli(dir, "run", "--only", "nope");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown gate(s): nope");
  });

  test("malformed config: exit 2", async () => {
    await Bun.write(join(dir, "bad.json"), "{ not json");
    const r = await cli(dir, "run", "--config", "bad.json");
    expect(r.exitCode).toBe(2);
  });

  test("duplicate gate names: exit 2", async () => {
    await writeConfig(dir, [
      { name: "dup", cost: 1, command: ["true"] },
      { name: "dup", cost: 2, command: ["true"] },
    ]);
    const r = await cli(dir, "run", "--quiet");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('duplicate gate name "dup"');
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
  });
});

describe("e2e: hint", () => {
  test("after failure: exit 1 with actionable text", async () => {
    await writeConfig(dir, [{ name: "boom", cost: 1, command: ["false"] }]);
    await cli(dir, "run", "--quiet");
    const r = await cli(dir, "hint");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("[boom]");
  });

  test("after success: exit 0, fresh verdict has no stale warning", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    await cli(dir, "run", "--quiet");
    const r = await cli(dir, "hint");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK, nothing to fix");
    expect(r.stderr).not.toContain("stale");
  });

  test("stale verdict triggers stderr warning", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    await cli(dir, "run", "--quiet");
    const path = join(dir, ".hyperfixer/verdict.json");
    const verdict = await Bun.file(path).json();
    verdict.generatedAt = "2020-01-01T00:00:00.000Z";
    await Bun.write(path, JSON.stringify(verdict));
    const r = await cli(dir, "hint");
    expect(r.stderr).toContain("stale");
  });

  test("malformed config: exit 2, not 1", async () => {
    const r = await cli(dir, "hint", "--config", "bad.json");
    expect(r.exitCode).toBe(2);
  });

  test("filtered run (--only) never looks stale by construction", async () => {
    await Bun.write(join(dir, "watched.txt"), "same");
    await writeConfig(dir, [
      { name: "a", cost: 1, command: ["true"], inputs: ["watched.txt"] },
      { name: "b", cost: 2, command: ["true"], inputs: ["watched.txt"] },
    ]);
    await cli(dir, "run", "--quiet", "--only", "a");
    const r = await cli(dir, "hint");
    expect(r.stderr).not.toContain("inputs changed");
  });

  test("content staleness: hint warns after an input file changes", async () => {
    await Bun.write(join(dir, "watched.txt"), "v1");
    await writeConfig(dir, [
      { name: "a", cost: 1, command: ["true"], inputs: ["watched.txt"] },
    ]);
    await cli(dir, "run", "--quiet");
    const fresh = await cli(dir, "hint");
    expect(fresh.stderr).not.toContain("inputs changed");
    await Bun.write(join(dir, "watched.txt"), "v2");
    const stale = await cli(dir, "hint");
    expect(stale.stderr).toContain("inputs changed since this verdict");
  });
});

describe("e2e: init and install-hooks", () => {
  test("init writes config once, refuses twice", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "hyperfixer-init-"));
    try {
      expect((await cli(fresh, "init")).exitCode).toBe(0);
      expect(await Bun.file(join(fresh, "hyperfixer.config.json")).exists()).toBe(true);
      expect((await cli(fresh, "init")).exitCode).toBe(2);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("install-hooks writes both hooks, keeps foreign hooks intact", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hyperfixer-hooks-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
      await Bun.write(join(repo, ".git/hooks/pre-push"), "#!/bin/sh\necho mine\n");
      const r = await cli(repo, "install-hooks");
      expect(r.exitCode).toBe(1);
      const preCommit = await Bun.file(join(repo, ".git/hooks/pre-commit")).text();
      expect(preCommit).toContain("installed by hyperfixer");
      expect(preCommit).toContain("--max-cost 50");
      const prePush = await Bun.file(join(repo, ".git/hooks/pre-push")).text();
      expect(prePush).toBe("#!/bin/sh\necho mine\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("install-hooks outside a git repo: exit 2", async () => {
    const bare = mkdtempSync(join(tmpdir(), "hyperfixer-nogit-"));
    try {
      expect((await cli(bare, "install-hooks")).exitCode).toBe(2);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
