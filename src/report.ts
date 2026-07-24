import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import { fileExists, readTextFile, writeTextFile } from "./runtime.ts";
import type { GateResult, GateStatus, Verdict } from "./types.ts";

const STATUS_BADGE: Record<GateStatus, string> = {
  pass: green("✓"),
  fail: red("✗"),
  skip: dim("-"),
  error: yellow("!"),
};

const MAX_FINDINGS_SHOWN = 10;

function renderGate(r: GateResult): string[] {
  const time = r.status === "skip" ? "" : dim(` (${r.durationMs}ms)`);
  const note = r.note ? dim(`, ${r.note}`) : "";
  const lines = [`${STATUS_BADGE[r.status]} ${bold(r.gate)}${time}${note}`];
  for (const f of r.findings.slice(0, MAX_FINDINGS_SHOWN)) {
    const loc = f.file
      ? `${cyan(`${f.file}${f.line !== undefined ? `:${f.line}` : ""}`)} `
      : "";
    lines.push(`    ${loc}${f.message}`);
  }
  // Count what the parser found, not what the verdict kept: the human report
  // must not understate the problem any more than the hint does.
  const total = r.findingsTotal ?? r.findings.length;
  if (total > MAX_FINDINGS_SHOWN) {
    lines.push(dim(`    … +${total - MAX_FINDINGS_SHOWN} more findings`));
  }
  return lines;
}

export function renderHuman(verdict: Verdict): string {
  const lines = verdict.gates.flatMap(renderGate);
  lines.push("");
  const filtered = Array.isArray(verdict.filteredGates) ? verdict.filteredGates : [];
  const scope = filtered.length === 0 ? "all gates" : "the gates that ran";
  if (filtered.length > 0) {
    lines.push(dim(`not run: ${filtered.join(", ")}`));
  }
  lines.push(
    verdict.ok
      ? green(bold(`OK`)) + dim(`, ${scope} passed in ${verdict.durationMs}ms`)
      : red(bold(`FAIL`)) +
          (verdict.failedGate === null ? "" : ` at gate ${bold(verdict.failedGate)}`) +
          `, ${verdict.hint ?? "see findings"}`,
  );
  return lines.join("\n");
}

export async function writeVerdict(verdict: Verdict, outDir: string): Promise<string> {
  const path = `${outDir}/verdict.json`;
  writeTextFile(path, `${JSON.stringify(verdict, null, 2)}\n`);
  return path;
}

/**
 * Trust boundary: verdict files are produced by this tool, so only the fields
 * the CLI branches on (ok, gates) are validated; gate elements are not
 * deep-checked. A hand-corrupted file may still render oddly, never crash.
 */
export async function readVerdict(outDir: string): Promise<Verdict | null> {
  const path = `${outDir}/verdict.json`;
  if (!fileExists(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readTextFile(path));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.ok !== "boolean" || !Array.isArray(v.gates)) return null;
  return raw as Verdict;
}
