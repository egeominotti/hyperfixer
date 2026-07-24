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
describe("e2e: fix and lock", () => {
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
    const r = await cli(dir, "fix");
    expect(r.exitCode).toBe(0);
    // fixer progress belongs on stderr: stdout carries the verdict
    expect(r.stderr).toContain("fix needs-fix");
    expect(r.stdout).not.toContain("fix needs-fix");
  });

  test("fix --json keeps stdout parseable", async () => {
    const marker = join(dir, "fixed-json.txt");
    await writeConfig(dir, [
      {
        name: "needs-fix",
        cost: 1,
        command: ["test", "-f", marker],
        fixCommand: ["sh", "-c", `printf ok > ${marker}`],
      },
    ]);
    const r = await cli(dir, "fix", "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
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

  // Stealing a stale lock is where two runs can both proceed: read then
  // unlink is not atomic, so the loser used to delete the winner's fresh lock
  // and both would write over the same verdict.json.
  test("many runs contending on a stale lock never overlap", async () => {
    const race = mkdtempSync(join(tmpdir(), "hyperfixer-race-"));
    try {
      // The gate itself detects overlap: it refuses to start while another
      // instance holds the sentinel, so a second concurrent run exits 1.
      const busy = join(race, "busy");
      await writeConfig(race, [
        {
          name: "exclusive",
          cost: 1,
          command: [
            "sh",
            "-c",
            `test ! -e ${busy} && touch ${busy} && sleep 0.5 && rm -f ${busy}`,
          ],
        },
      ]);
      await Bun.write(
        join(race, ".hyperfixer/lock"),
        JSON.stringify({ pid: 999_999_997, at: Date.now(), nonce: "dead" }),
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, () => cli(race, "run", "--quiet", "--no-cache")),
      );
      const codes = results.map((r) => r.exitCode);
      // exit 1 means two runs were inside the gate at the same time
      expect(codes.filter((c) => c === 1).length).toBe(0);
      expect(codes.filter((c) => c === 0).length).toBeGreaterThanOrEqual(1);
      expect(codes.every((c) => c === 0 || c === 2)).toBe(true);
    } finally {
      rmSync(race, { recursive: true, force: true });
    }
  }, 30_000);

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
