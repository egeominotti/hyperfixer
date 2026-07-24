import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import { runPipeline } from "../../src/runner.ts";
import type { GateResult, GateSpec, GateStatus, Verdict } from "../../src/types.ts";

test("public API types", () => {
  expectTypeOf<GateStatus>().toEqualTypeOf<"pass" | "fail" | "skip" | "error">();
  expectTypeOf<Verdict["failedGate"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Verdict["gates"]>().toEqualTypeOf<GateResult[]>();
  expectTypeOf(runPipeline).returns.resolves.toEqualTypeOf<Verdict>();

  // Negative: a gate spec without a cost must not typecheck.
  // @ts-expect-error cost is required
  const bad: GateSpec = { name: "x" };
  void bad;
});
