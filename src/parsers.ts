import type { Finding, ParserKind } from "./types.ts";

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export function parseTsc(output: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of output.split("\n")) {
    const m = TSC_LINE.exec(line.trim());
    if (!m) continue;
    const [, file, ln, col, code, message] = m;
    if (file === undefined || ln === undefined || col === undefined || code === undefined)
      continue;
    findings.push({
      file,
      line: Number(ln),
      column: Number(col),
      code,
      message: message ?? "",
    });
  }
  return findings;
}

// bun test failure lines look like:  "(fail) suite > test name [1.23ms]"
const BUN_FAIL = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?$/;
// error location lines look like:  "      at <anonymous> (/path/file.test.ts:12:5)"
const BUN_LOC = /\(([^()]+\.[cm]?[jt]sx?):(\d+):(\d+)\)/;

export function parseBunTest(output: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (current === undefined) continue;
    const m = BUN_FAIL.exec(current.trim());
    if (!m) continue;
    // Look back a few lines for the nearest stack location above the (fail) line.
    let file: string | undefined;
    let line: number | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      const above = lines[j];
      const loc = above === undefined ? null : BUN_LOC.exec(above);
      if (loc) {
        file = loc[1];
        line = Number(loc[2]);
        break;
      }
    }
    const finding: Finding = { message: `test failed: ${m[1]}` };
    if (file !== undefined) finding.file = file;
    if (line !== undefined) finding.line = line;
    findings.push(finding);
  }
  return findings;
}

export function parseOutput(kind: ParserKind, output: string): Finding[] {
  switch (kind) {
    case "tsc":
      return parseTsc(output);
    case "bun-test":
      return parseBunTest(output);
    case "raw":
      return [];
  }
}
