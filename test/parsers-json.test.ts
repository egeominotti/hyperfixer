import { describe, expect, test } from "bun:test";
import { extractJson, parseEslintJson, parseFindingsJson } from "../src/parsers-json.ts";

describe("extractJson", () => {
  test("finds JSON surrounded by tool noise", () => {
    expect(extractJson('warning: legacy config\n[{"a":1}]\ndone in 5ms')).toEqual([
      { a: 1 },
    ]);
  });

  test("handles brackets inside strings", () => {
    expect(extractJson('x ["a]b", "c"] y')).toEqual(["a]b", "c"]);
  });

  test("garbage yields null", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("[broken")).toBeNull();
  });
});

describe("parseEslintJson", () => {
  const output = JSON.stringify([
    {
      filePath: "/repo/src/a.ts",
      messages: [
        {
          line: 3,
          column: 7,
          severity: 1,
          message: "prefer const",
          ruleId: "prefer-const",
        },
        {
          line: 9,
          column: 1,
          severity: 2,
          message: "x is not defined",
          ruleId: "no-undef",
        },
      ],
    },
    { filePath: "/repo/src/b.ts", messages: [] },
  ]);

  test("errors come first, rule id embedded", () => {
    const findings = parseEslintJson(output);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      file: "/repo/src/a.ts",
      line: 9,
      column: 1,
      code: "no-undef",
      message: "x is not defined (no-undef)",
    });
    expect(findings[1]?.message).toBe("prefer const (prefer-const)");
  });

  test("non-eslint output yields no findings", () => {
    expect(parseEslintJson("plain text")).toEqual([]);
    expect(parseEslintJson('{"not":"an array"}')).toEqual([]);
  });
});

describe("parseFindingsJson", () => {
  test("accepts a bare array in hyperfixer shape", () => {
    const out = JSON.stringify([
      { file: "src/x.py", line: 12, message: "assert failed", code: "E1" },
      { message: "no location" },
    ]);
    const findings = parseFindingsJson(out);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      file: "src/x.py",
      line: 12,
      code: "E1",
      message: "assert failed",
    });
  });

  test("accepts { findings: [...] } and drops malformed items", () => {
    const out = JSON.stringify({
      findings: [{ message: "ok" }, { nope: true }, 42, { message: 5 }],
    });
    expect(parseFindingsJson(out)).toEqual([{ message: "ok" }]);
  });

  test("garbage yields no findings", () => {
    expect(parseFindingsJson("boom")).toEqual([]);
  });
});
