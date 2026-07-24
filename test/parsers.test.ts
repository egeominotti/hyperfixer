import { describe, expect, test } from "bun:test";
import { parseBunTest, parseTsc } from "../src/parsers.ts";

describe("parseTsc", () => {
  test("extracts file, position, code, message", () => {
    const out = [
      "src/runner.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "some unrelated line",
      "test/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
    ].join("\n");
    const findings = parseTsc(out);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      file: "src/runner.ts",
      line: 12,
      column: 5,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    });
  });

  test("clean output yields no findings", () => {
    expect(parseTsc("")).toEqual([]);
  });

  test("location-less config errors still produce a finding", () => {
    const out = [
      "error TS2688: Cannot find type definition file for 'bun-types'.",
      "  The file is in the program because:",
    ].join("\n");
    const findings = parseTsc(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      code: "TS2688",
      message: "Cannot find type definition file for 'bun-types'.",
    });
  });
});

describe("parseBunTest", () => {
  test("extracts failing test names with nearest location", () => {
    const out = [
      "test/runner.test.ts:",
      "1 | import x",
      "error: expect(received).toBe(expected)",
      "      at <anonymous> (/repo/test/runner.test.ts:42:7)",
      "(fail) runner > fail-fast skips later gates [0.42ms]",
      "(pass) runner > runs gates in cost order [0.10ms]",
    ].join("\n");
    const findings = parseBunTest(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      message: "test failed: runner > fail-fast skips later gates",
      file: "/repo/test/runner.test.ts",
      line: 42,
    });
  });

  test("all passing yields no findings", () => {
    expect(parseBunTest("(pass) a\n(pass) b\n 2 pass\n 0 fail")).toEqual([]);
  });

  test("fast-check replay data is surfaced as a finding", () => {
    const out = [
      "error: Property failed after 301 tests",
      '{ seed: -1153236681, path: "300:1:2", endOnFailure: true }',
      'Counterexample: [[{"unitPrice":11470,"quantity":821}],[],0.05]',
      "Shrunk 46 time(s)",
      "      at <anonymous> (/repo/test/property/p.test.ts:23:5)",
      "(fail) pricing invariants > quote arithmetic balances [12.00ms]",
    ].join("\n");
    const findings = parseBunTest(out);
    expect(findings).toHaveLength(2);
    expect(findings[1]!.message).toBe(
      'fast-check: counterexample [[{"unitPrice":11470,"quantity":821}],[],0.05], replay with { seed: -1153236681, path: "300:1:2" }',
    );
  });

  test("seed-only failure without counterexample still surfaces replay data", () => {
    const findings = parseBunTest('{ seed: 42, path: "0:1", endOnFailure: true }');
    expect(findings).toEqual([
      { message: 'fast-check: replay with { seed: 42, path: "0:1" }' },
    ]);
  });
});
