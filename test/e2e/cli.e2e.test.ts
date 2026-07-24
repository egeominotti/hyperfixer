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
    // a partial green must announce itself, here and in hint
    expect(verdict.filteredGates).toEqual(["pricey"]);
    const h = await cli(dir, "hint");
    expect(h.stdout).toContain("pricey");
    expect(h.stdout).toContain("not run");
  });

  test("--json survives a pipe: no truncation at the pipe buffer", async () => {
    // 3000 tsc-shaped errors parse into a verdict far past the 64 KB a pipe
    // holds, which process.exit would have discarded mid-document.
    await writeConfig(dir, [
      {
        name: "loud",
        cost: 1,
        parser: "tsc",
        command: [
          "sh",
          "-c",
          "for i in $(seq 1 3000); do echo \"src/f$i.ts($i,7): error TS2322: Type 'string' is not assignable to type 'number'.\"; done; exit 1",
        ],
      },
    ]);
    const r = await cli(dir, "run", "--json");
    expect(r.exitCode).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(70_000);
    // Capped at MAX_FINDINGS, but still far past what a pipe holds at once.
    expect(JSON.parse(r.stdout).gates[0].findings.length).toBe(1000);
  });

  test("explicit --config pointing at a missing file: exit 2, never the defaults", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    const r = await cli(dir, "run", "--quiet", "--config", "typo.json");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("config file not found");
  });

  // The verdict is written for an agent to read: an unbounded findings array
  // would make it unreadable, and the hint only ever names the first one.
  test("findings are capped and the drop is recorded", async () => {
    await writeConfig(dir, [
      {
        name: "loud",
        cost: 1,
        parser: "tsc",
        command: [
          "sh",
          "-c",
          'for i in $(seq 1 1200); do echo "src/f$i.ts($i,1): error TS2322: nope."; done; exit 1',
        ],
      },
    ]);
    const r = await cli(dir, "run", "--quiet", "--no-cache");
    expect(r.exitCode).toBe(1);
    const verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
    expect(verdict.gates[0].findings.length).toBe(1000);
    expect(verdict.gates[0].note).toContain("200 more findings not recorded");
    expect(verdict.gates[0].findingsTotal).toBe(1200);
    // The first finding still drives the hint, and the count is the real one,
    // not the number that survived the cap.
    expect(verdict.hint).toContain("src/f1.ts:1");
    expect(verdict.hint).toContain("+1199 more");
  });

  test("hint survives a hand corrupted filteredGates", async () => {
    await writeConfig(dir, [{ name: "a", cost: 1, command: ["true"] }]);
    await cli(dir, "run", "--quiet");
    const path = join(dir, ".hyperfixer/verdict.json");
    const verdict = await Bun.file(path).json();
    verdict.filteredGates = "mutation";
    await Bun.write(path, JSON.stringify(verdict));
    const r = await cli(dir, "hint");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK, nothing to fix");
    expect(r.stderr).not.toContain("is not a function");
  });

  test("gate command that is not an array of strings: exit 2", async () => {
    await Bun.write(
      join(dir, "strcmd.json"),
      JSON.stringify({ gates: [{ name: "unit", cost: 1, command: "bun test" }] }),
    );
    const r = await cli(dir, "run", "--quiet", "--config", "strcmd.json");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"command" must be an array of strings');
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
});
