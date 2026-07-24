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
    expect(findings[0]!.message).toContain("fail-fast skips later gates");
    expect(findings[0]!.file).toBe("/repo/test/runner.test.ts");
    expect(findings[0]!.line).toBe(42);
  });

  test("all passing yields no findings", () => {
    expect(parseBunTest("(pass) a\n(pass) b\n 2 pass\n 0 fail")).toEqual([]);
  });
});
