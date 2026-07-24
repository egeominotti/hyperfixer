import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
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
  const note = r.note ? dim(` — ${r.note}`) : "";
  const lines = [`${STATUS_BADGE[r.status]} ${bold(r.gate)}${time}${note}`];
  for (const f of r.findings.slice(0, MAX_FINDINGS_SHOWN)) {
    const loc = f.file
      ? `${cyan(`${f.file}${f.line !== undefined ? `:${f.line}` : ""}`)} `
      : "";
    lines.push(`    ${loc}${f.message}`);
  }
  if (r.findings.length > MAX_FINDINGS_SHOWN) {
    lines.push(dim(`    … +${r.findings.length - MAX_FINDINGS_SHOWN} more findings`));
  }
  return lines;
}

export function renderHuman(verdict: Verdict): string {
  const lines = verdict.gates.flatMap(renderGate);
  lines.push("");
  lines.push(
    verdict.ok
      ? green(bold(`OK`)) + dim(` — all gates passed in ${verdict.durationMs}ms`)
      : red(bold(`FAIL`)) +
          ` at gate ${bold(String(verdict.failedGate))} — ${verdict.hint ?? "see findings"}`,
  );
  return lines.join("\n");
}

export async function writeVerdict(verdict: Verdict, outDir: string): Promise<string> {
  const path = `${outDir}/verdict.json`;
  await Bun.write(path, `${JSON.stringify(verdict, null, 2)}\n`);
  return path;
}

export async function readVerdict(outDir: string): Promise<Verdict | null> {
  const file = Bun.file(`${outDir}/verdict.json`);
  if (!(await file.exists())) return null;
  return (await file.json()) as Verdict;
}
