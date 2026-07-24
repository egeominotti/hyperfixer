import { describe, expect, test } from "bun:test";
import { runPipeline, spawnExecutor } from "../src/runner.ts";
import type { GateExecutor, GateSpec, GateStatus } from "../src/types.ts";

function gate(name: string, cost: number, extra: Partial<GateSpec> = {}): GateSpec {
  return { name, cost, ...extra };
}

function fakeExec(statuses: Record<string, GateStatus>): GateExecutor {
  return async (g) => ({
    gate: g.name,
    status: statuses[g.name] ?? "pass",
    durationMs: 1,
    exitCode: statuses[g.name] === "pass" ? 0 : 1,
    findings: [],
    outputTail: "",
  });
}

const baseConfig = { failFast: true, outDir: ".hyperfixer" };

describe("runPipeline", () => {
  test("runs gates in cost order", async () => {
    const order: string[] = [];
    const exec: GateExecutor = async (g) => {
      order.push(g.name);
      return await fakeExec({})(g);
    };
    await runPipeline(
      { ...baseConfig, gates: [gate("c", 30), gate("a", 10), gate("b", 20)] },
      exec,
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("same-cost gates run as one group, a failure does not skip siblings", async () => {
    const verdict = await runPipeline(
      {
        ...baseConfig,
        gates: [gate("a", 1), gate("b", 1), gate("c", 2)],
      },
      fakeExec({ a: "fail" }),
    );
    expect(verdict.gates.map((g) => [g.gate, g.status])).toEqual([
      ["a", "fail"],
      ["b", "pass"],
      ["c", "skip"],
    ]);
  });

  test("fail-fast skips later gates", async () => {
    const verdict = await runPipeline(
      { ...baseConfig, gates: [gate("a", 1), gate("b", 2), gate("c", 3)] },
      fakeExec({ b: "fail" }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failedGate).toBe("b");
    expect(verdict.gates.map((g) => g.status)).toEqual(["pass", "fail", "skip"]);
  });

  test("failFast=false runs everything", async () => {
    const verdict = await runPipeline(
      {
        ...baseConfig,
        failFast: false,
        gates: [gate("a", 1), gate("b", 2), gate("c", 3)],
      },
      fakeExec({ a: "fail" }),
    );
    expect(verdict.gates.map((g) => g.status)).toEqual(["fail", "pass", "pass"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedGate).toBe("a");
  });

  test("zero gates executed is never ok", async () => {
    const empty = await runPipeline({ ...baseConfig, gates: [] }, fakeExec({}));
    expect(empty.ok).toBe(false);
    expect(empty.hint).toContain("no gates executed");

    const allSkipped = await runPipeline(
      { ...baseConfig, gates: [gate("a", 1)] },
      fakeExec({ a: "skip" }),
    );
    expect(allSkipped.ok).toBe(false);
  });

  test("disabled gates are excluded entirely", async () => {
    const verdict = await runPipeline(
      { ...baseConfig, gates: [gate("a", 1), gate("b", 2, { enabled: false })] },
      fakeExec({}),
    );
    expect(verdict.gates.map((g) => g.gate)).toEqual(["a"]);
  });
});

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
});
