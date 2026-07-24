/**
 * Differential gate: runPipeline must agree with an independent, deliberately
 * naive reference implementation of the verdict semantics on thousands of
 * generated pipelines. Exit 1 on divergence, with fast-check replay data.
 */
import fc from "fast-check";
import { runPipeline } from "../src/runner.ts";
import type { GateExecutor, GateSpec, GateStatus } from "../src/types.ts";

const statusArb = fc.constantFrom<GateStatus>("pass", "fail", "skip", "error");

const pipelineArb = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 10 })
  .chain((names) =>
    fc.tuple(
      fc.constant(names),
      fc.array(fc.integer({ min: 0, max: 50 }), {
        minLength: names.length,
        maxLength: names.length,
      }),
      fc.array(statusArb, { minLength: names.length, maxLength: names.length }),
      fc.boolean(),
    ),
  )
  .map(([names, costs, statuses, failFast]) => ({
    gates: names.map((name, i) => ({ name, cost: costs[i] ?? 0 })) as GateSpec[],
    statuses: new Map(names.map((n, i) => [n, statuses[i] ?? "pass"])),
    failFast,
  }));

/** Naive oracle: recompute expected per-gate status and ok from first principles. */
function reference(
  gates: GateSpec[],
  statuses: Map<string, GateStatus>,
  failFast: boolean,
): { ok: boolean; failedGate: string | null; byGate: Map<string, GateStatus> } {
  const sorted = [...gates].sort((a, b) => a.cost - b.cost);
  const isBlocking = (s: GateStatus) => s === "fail" || s === "error";
  let blockCost = Number.POSITIVE_INFINITY;
  if (failFast) {
    for (const g of sorted) {
      const s = statuses.get(g.name) ?? "pass";
      if (isBlocking(s)) {
        blockCost = Math.min(blockCost, g.cost);
      }
    }
  }
  const byGate = new Map<string, GateStatus>();
  for (const g of sorted) {
    byGate.set(g.name, g.cost > blockCost ? "skip" : (statuses.get(g.name) ?? "pass"));
  }
  const values = [...byGate.values()];
  const failed = sorted.find((g) => isBlocking(byGate.get(g.name) ?? "pass"));
  const executed = values.some((s) => s !== "skip");
  return {
    ok: failed === undefined && executed,
    failedGate: failed?.name ?? null,
    byGate,
  };
}

const exec =
  (statuses: Map<string, GateStatus>): GateExecutor =>
  async (g) => ({
    gate: g.name,
    status: statuses.get(g.name) ?? "pass",
    durationMs: 0,
    exitCode: 0,
    findings: [],
    outputTail: "",
  });

try {
  fc.assert(
    fc.asyncProperty(pipelineArb, async ({ gates, statuses, failFast }) => {
      const verdict = await runPipeline(
        { gates, failFast, outDir: ".hyperfixer" },
        exec(statuses),
      );
      const oracle = reference(gates, statuses, failFast);
      if (verdict.ok !== oracle.ok || verdict.failedGate !== oracle.failedGate) {
        throw new Error(
          `verdict divergence, got ok=${verdict.ok} failedGate=${verdict.failedGate}, oracle ok=${oracle.ok} failedGate=${oracle.failedGate}`,
        );
      }
      for (const r of verdict.gates) {
        if (r.status !== oracle.byGate.get(r.gate)) {
          throw new Error(
            `status divergence on "${r.gate}", got ${r.status}, oracle ${oracle.byGate.get(r.gate)}`,
          );
        }
      }
    }),
    { numRuns: 2000 },
  );
  console.log("parity: runPipeline agrees with the reference oracle on 2000 pipelines");
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
