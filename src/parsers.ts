import { parseEslintJson, parseFindingsJson } from "./parsers-json.ts";
import type { Finding, ParserKind } from "./types.ts";

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// Config-level errors carry no location, e.g. "error TS2688: Cannot find …".
const TSC_BARE = /^error (TS\d+): (.*)$/;

export function parseTsc(output: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const m = TSC_LINE.exec(trimmed);
    if (m) {
      const [, file, ln, col, code, message] = m;
      if (
        file === undefined ||
        ln === undefined ||
        col === undefined ||
        code === undefined
      )
        continue;
      findings.push({
        file,
        line: Number(ln),
        column: Number(col),
        code,
        message: message ?? "",
      });
      continue;
    }
    const bare = TSC_BARE.exec(trimmed);
    if (bare?.[1] !== undefined) {
      findings.push({ code: bare[1], message: bare[2] ?? "" });
    }
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
  // Property tests print replay data on failure: surface it so an agent can
  // re-run the exact failing case.
  findings.push(...parseFastCheck(output));
  return findings;
}

// fast-check failure output:  "{ seed: -123, path: "300:1:2", endOnFailure: true }"
const FC_SEED = /\{\s*seed:\s*(-?\d+),\s*path:\s*"([^"]+)"/;
const FC_COUNTEREXAMPLE = /^Counterexample:\s*(.*)$/m;

export function parseFastCheck(output: string): Finding[] {
  const seed = FC_SEED.exec(output);
  const cx = FC_COUNTEREXAMPLE.exec(output);
  if (!seed && !cx) return [];
  const parts: string[] = [];
  if (cx?.[1]) parts.push(`counterexample ${cx[1]}`);
  if (seed?.[1] !== undefined && seed[2] !== undefined) {
    parts.push(`replay with { seed: ${seed[1]}, path: "${seed[2]}" }`);
  }
  return [{ message: `fast-check: ${parts.join(", ")}` }];
}

export function parseOutput(kind: ParserKind, output: string): Finding[] {
  switch (kind) {
    case "tsc":
      return parseTsc(output);
    case "bun-test":
      return parseBunTest(output);
    case "fast-check":
      return parseFastCheck(output);
    case "eslint-json":
      return parseEslintJson(output);
    case "findings-json":
      return parseFindingsJson(output);
    case "raw":
      return [];
  }
}
