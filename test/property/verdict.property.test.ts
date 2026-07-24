import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { runPipeline } from "../../src/runner.ts";
import type { GateExecutor, GateStatus } from "../../src/types.ts";

const statusArb = fc.constantFrom<GateStatus>("pass", "fail", "skip", "error");

const gatesArb = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 12 })
  .chain((names) =>
    fc.tuple(
      fc.constant(names),
      fc.array(fc.integer({ min: 0, max: 1000 }), {
        minLength: names.length,
        maxLength: names.length,
      }),
      fc.array(statusArb, { minLength: names.length, maxLength: names.length }),
    ),
  )
  .map(([names, costs, statuses]) => ({
    gates: names.map((name, i) => ({ name, cost: costs[i]! })),
    statuses: Object.fromEntries(names.map((n, i) => [n, statuses[i]!])),
  }));

function execFrom(statuses: Record<string, GateStatus>): GateExecutor {
  return async (g) => ({
    gate: g.name,
    status: statuses[g.name] ?? "pass",
    durationMs: 0,
    exitCode: 0,
    findings: [],
    outputTail: "",
  });
}

describe("verdict invariants", () => {
  test("ok <=> no gate failed or errored; failedGate consistent", async () => {
    await fc.assert(
      fc.asyncProperty(gatesArb, fc.boolean(), async ({ gates, statuses }, failFast) => {
        const verdict = await runPipeline(
          { gates, failFast, outDir: ".hyperfixer" },
          execFrom(statuses),
        );
        const blocking = verdict.gates.filter(
          (r) => r.status === "fail" || r.status === "error",
        );
        const executed = verdict.gates.some((r) => r.status !== "skip");
        expect(verdict.ok).toBe(blocking.length === 0 && executed);
        expect(verdict.failedGate).toBe(blocking[0]?.gate ?? null);
        // Every configured gate appears exactly once in the verdict.
        expect(verdict.gates.map((r) => r.gate).sort()).toEqual(
          gates.map((g) => g.name).sort(),
        );
        // hint present iff not ok.
        expect(verdict.hint !== null).toBe(!verdict.ok);
      }),
    );
  });

  test("failFast: everything after first blocking gate is skipped", async () => {
    await fc.assert(
      fc.asyncProperty(gatesArb, async ({ gates, statuses }) => {
        const verdict = await runPipeline(
          { gates, failFast: true, outDir: ".hyperfixer" },
          execFrom(statuses),
        );
        const idx = verdict.gates.findIndex(
          (r) => r.status === "fail" || r.status === "error",
        );
        if (idx === -1) return;
        for (const later of verdict.gates.slice(idx + 1)) {
          expect(later.status).toBe("skip");
        }
      }),
    );
  });
});
