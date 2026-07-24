import { describe, expect, test } from "bun:test";
import { exitCodeFor, spawnExecutor } from "../src/runner.ts";
import type { GateResult, GateSpec, Verdict } from "../src/types.ts";

function gate(name: string, cost: number, extra: Partial<GateSpec> = {}): GateSpec {
  return { name, cost, ...extra };
}

/** Minimal verdict wrapper, for asserting the exit code a result maps to. */
function verdictOf(gates: GateResult[]): Verdict {
  return {
    ok: false,
    generatedAt: new Date(0).toISOString(),
    failedGate: gates[0]?.gate ?? null,
    gates,
    durationMs: 1,
    hint: null,
  };
}

describe("spawnExecutor", () => {
  test("passing command", async () => {
    const r = await spawnExecutor(gate("ok", 1, { command: ["true"] }));
    expect(r.status).toBe("pass");
    expect(r.exitCode).toBe(0);
  });

  test("failing command", async () => {
    const r = await spawnExecutor(gate("ko", 1, { command: ["false"] }));
    expect(r.status).toBe("fail");
    expect(r.exitCode).toBe(1);
  });

  test("missing command skips", async () => {
    const r = await spawnExecutor(gate("none", 1));
    expect(r.status).toBe("skip");
  });

  test("hanging command times out as error", async () => {
    const r = await spawnExecutor(
      gate("hang", 1, { command: ["sleep", "5"], timeoutMs: 80 }),
    );
    expect(r.status).toBe("error");
    expect(r.note).toContain("timed out after 80ms");
  });

  test("nonexistent binary: error when required, skip when optional", async () => {
    const required = await spawnExecutor(
      gate("bin", 1, { command: ["definitely-not-a-binary-xyz"] }),
    );
    expect(required.status).toBe("error");
    const optional = await spawnExecutor(
      gate("bin", 1, { command: ["definitely-not-a-binary-xyz"], optional: true }),
    );
    expect(optional.status).toBe("skip");
  });

  // A signal death is the tool crashing, not the code being wrong: reporting
  // it as fail would send an agent editing code over an out of memory kill.
  test("killed by a signal is infrastructure error, not a code failure", async () => {
    const r = await spawnExecutor(
      gate("crash", 1, { command: ["sh", "-c", "kill -9 $$"] }),
    );
    expect(r.status).toBe("error");
    expect(r.note).toContain("SIGKILL");
    expect(exitCodeFor(verdictOf([r]))).toBe(3);
  });

  // A throwing parser used to be caught by the spawn handler and reported as
  // "command failed to start", which for an optional gate meant skip, and a
  // skipped gate leaves the run green.
  test("a parser that throws keeps the gate failing", async () => {
    const command = [
      "sh",
      "-c",
      'echo \'[{"filePath":"a.ts","messages":[null]}]\'; exit 1',
    ];
    const r = await spawnExecutor(
      gate("lint", 1, { command, parser: "eslint-json", optional: true }),
    );
    expect(r.status).toBe("fail");
    expect(r.exitCode).toBe(1);
    expect(r.note).toContain("parser eslint-json failed");
    expect(r.outputTail).toContain("filePath");
    expect(exitCodeFor(verdictOf([r]))).toBe(1);
  });
});
