import { describe, expect, test } from "bun:test";
import { buildHint, exitCodeFor, runPipeline, spawnExecutor } from "../src/runner.ts";
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

describe("exitCodeFor", () => {
  test("full contract mapping", async () => {
    const verdictWith = async (statuses: Record<string, GateStatus>, names: string[]) =>
      runPipeline(
        { ...baseConfig, gates: names.map((n, i) => gate(n, i + 1)) },
        fakeExec(statuses),
      );

    expect(exitCodeFor(await verdictWith({}, ["a"]))).toBe(0);
    expect(exitCodeFor(await verdictWith({ a: "fail" }, ["a", "b"]))).toBe(1);
    expect(exitCodeFor(await verdictWith({ a: "error" }, ["a", "b"]))).toBe(3);
    // A code failure always dominates an infra error, whatever the order.
    const mixed = {
      ...baseConfig,
      gates: [gate("e", 1), gate("f", 1)],
    };
    expect(
      exitCodeFor(await runPipeline(mixed, fakeExec({ e: "error", f: "fail" }))),
    ).toBe(1);
    expect(
      exitCodeFor(await runPipeline(mixed, fakeExec({ e: "fail", f: "error" }))),
    ).toBe(1);
    // pass then error later: first blocking is the error
    expect(exitCodeFor(await verdictWith({ b: "error" }, ["a", "b"]))).toBe(3);
    // empty pipeline is a setup problem
    expect(
      exitCodeFor(await runPipeline({ ...baseConfig, gates: [] }, fakeExec({}))),
    ).toBe(2);
    expect(exitCodeFor(await verdictWith({ a: "skip" }, ["a"]))).toBe(2);
  });
});

describe("buildHint", () => {
  const result = (over: object) => ({
    gate: "g",
    status: "fail" as const,
    durationMs: 0,
    exitCode: 1,
    findings: [],
    outputTail: "",
    ...over,
  });

  test("finding with file, line and remainder count", () => {
    const hint = buildHint([
      result({
        findings: [
          { file: "src/a.ts", line: 3, message: "boom" },
          { message: "second" },
          { message: "third" },
        ],
      }),
    ]);
    expect(hint).toBe("[g] src/a.ts:3, boom (+2 more)");
  });

  test("finding without file uses message only", () => {
    expect(buildHint([result({ findings: [{ message: "boom" }] })])).toBe("[g] boom");
  });

  test("no findings falls back to note, then exit code", () => {
    expect(buildHint([result({ note: "timed out after 5ms" })])).toBe(
      "[g] timed out after 5ms",
    );
    expect(buildHint([result({})])).toBe("[g] exit code 1");
  });

  test("null when nothing blocks", () => {
    expect(buildHint([result({ status: "pass", exitCode: 0 })])).toBeNull();
    expect(buildHint([])).toBeNull();
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
