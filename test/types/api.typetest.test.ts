import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import { runPipeline } from "../../src/runner.ts";
import type { GateResult, GateSpec, GateStatus, Verdict } from "../../src/types.ts";

test("public API types", () => {
  expectTypeOf<GateStatus>().toEqualTypeOf<"pass" | "fail" | "skip" | "error">();
  expectTypeOf<Verdict["failedGate"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Verdict["gates"]>().toEqualTypeOf<GateResult[]>();
  // Optional: a full run omits it, so consumers must handle its absence.
  expectTypeOf<Verdict["filteredGates"]>().toEqualTypeOf<string[] | undefined>();
  // Same for the real finding count, present only when findings were capped.
  expectTypeOf<GateResult["findingsTotal"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf(runPipeline).returns.resolves.toEqualTypeOf<Verdict>();

  // Negative: a gate spec without a cost must not typecheck.
  // @ts-expect-error cost is required
  const bad: GateSpec = { name: "x" };
  void bad;

  // Negative: a verdict cannot claim a filtered gate list of anything else.
  // @ts-expect-error filteredGates is a string array
  const wrong: Verdict["filteredGates"] = "mutation";
  void wrong;
});
