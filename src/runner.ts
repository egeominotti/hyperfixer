import { parseOutput } from "./parsers.ts";
import { spawnCapture } from "./runtime.ts";
import type {
  Finding,
  GateExecutor,
  GateResult,
  GateSpec,
  HyperfixerConfig,
  Verdict,
} from "./types.ts";

const TAIL_CHARS = 4000;
// Findings kept per gate: a tool emitting hundreds of thousands of errors
// would write a verdict too large for the agent that has to read it.
const MAX_FINDINGS = 1000;
const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

function skippedResult(gate: GateSpec, note: string): GateResult {
  return {
    gate: gate.name,
    status: "skip",
    durationMs: 0,
    exitCode: null,
    findings: [],
    outputTail: "",
    note,
  };
}

export const spawnExecutor: GateExecutor = async (gate) => {
  const start = performance.now();
  const command = gate.command ?? [];
  if (command.length === 0) return skippedResult(gate, "no command configured");
  const timeoutMs = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Awaited<ReturnType<typeof spawnCapture>>;
  try {
    res = await spawnCapture(command, { timeoutMs, killGraceMs: KILL_GRACE_MS });
  } catch (e) {
    return {
      gate: gate.name,
      status: gate.optional ? "skip" : "error",
      durationMs: Math.round(performance.now() - start),
      exitCode: null,
      findings: [],
      outputTail: "",
      note: `command failed to start: ${message(e)}`,
    };
  }
  const combined = res.stdout + (res.stderr ? `\n${res.stderr}` : "");
  const base = {
    gate: gate.name,
    durationMs: Math.round(performance.now() - start),
    outputTail: combined.slice(-TAIL_CHARS),
  };
  if (res.timedOut) {
    return {
      ...base,
      status: "error",
      exitCode: null,
      findings: [],
      note: `timed out after ${timeoutMs}ms`,
    };
  }
  // A gate killed by a signal (SIGSEGV, an out of memory kill) reports exit
  // code null, which is not the code being wrong: infrastructure failed.
  if (res.signal !== null) {
    return {
      ...base,
      status: "error",
      exitCode: res.exitCode,
      findings: [],
      note: `killed by ${res.signal}`,
    };
  }
  // Parsing sits outside the spawn try: a parser bug read as a failed spawn
  // would downgrade an optional gate to skip, turning the run green.
  let findings: Finding[] = [];
  const notes: string[] = [];
  try {
    findings = parseOutput(gate.parser ?? "raw", combined);
  } catch (e) {
    notes.push(`parser ${gate.parser ?? "raw"} failed: ${message(e)}`);
  }
  const total = findings.length;
  const dropped = total - MAX_FINDINGS;
  if (dropped > 0) {
    notes.push(`${dropped} more finding${dropped === 1 ? "" : "s"} not recorded`);
    findings = findings.slice(0, MAX_FINDINGS);
  }
  if (res.truncated) notes.push("output truncated");
  const result: GateResult = {
    ...base,
    status: res.exitCode === 0 ? "pass" : "fail",
    exitCode: res.exitCode,
    findings,
    ...(total > findings.length ? { findingsTotal: total } : {}),
  };
  return notes.length === 0 ? result : { ...result, note: notes.join(", ") };
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildHint(results: GateResult[]): string | null {
  const blocking = results.find((r) => r.status === "fail" || r.status === "error");
  if (!blocking) return null;
  const first = blocking.findings[0];
  if (first) {
    const loc = first.file
      ? `${first.file}${first.line !== undefined ? `:${first.line}` : ""}, `
      : "";
    // What the parser found, not what the verdict kept: the hint is read
    // first and must not understate the problem.
    const total = blocking.findingsTotal ?? blocking.findings.length;
    const more = total > 1 ? ` (+${total - 1} more)` : "";
    return `[${blocking.gate}] ${loc}${first.message}${more}`;
  }
  return `[${blocking.gate}] ${blocking.note ?? `exit code ${blocking.exitCode}`}`;
}

/**
 * The exit-code contract, in one place: 0 verified, 1 the code is wrong, 2 the
 * setup is wrong (config error upstream, empty pipeline here), 3 gate
 * infrastructure failed (timeout, tool crash), do not edit code for a 3.
 */
export function exitCodeFor(verdict: Verdict): 0 | 1 | 2 | 3 {
  if (verdict.ok) return 0;
  if (!verdict.gates.some((r) => r.status !== "skip")) return 2;
  // A real code failure always dominates an infra error: never hide a fix
  // the agent must make behind "do not edit code".
  if (verdict.gates.some((r) => r.status === "fail")) return 1;
  return 3;
}

export async function runPipeline(
  config: HyperfixerConfig,
  exec: GateExecutor = spawnExecutor,
): Promise<Verdict> {
  const start = performance.now();
  const gates = config.gates
    .filter((g) => g.enabled !== false)
    .sort((a, b) => a.cost - b.cost);

  // Gates with equal cost form a group and run concurrently; groups run in
  // cost order and fail-fast blocks later groups, never same-group siblings.
  const results: GateResult[] = [];
  let blocked = false;
  let i = 0;
  while (i < gates.length) {
    const head = gates[i];
    if (head === undefined) break;
    const group: GateSpec[] = [];
    while (i < gates.length) {
      const g = gates[i];
      if (g === undefined || g.cost !== head.cost) break;
      group.push(g);
      i++;
    }
    if (blocked) {
      for (const g of group) results.push(skippedResult(g, "earlier gate failed"));
      continue;
    }
    const groupResults = await Promise.all(group.map((g) => exec(g)));
    results.push(...groupResults);
    if (
      config.failFast &&
      groupResults.some((r) => r.status === "fail" || r.status === "error")
    ) {
      blocked = true;
    }
  }

  const failed = results.find((r) => r.status === "fail" || r.status === "error");
  // "Ran nothing" must never masquerade as green: ok requires at least one
  // gate to have actually executed.
  const executed = results.some((r) => r.status !== "skip");
  return {
    ok: failed === undefined && executed,
    generatedAt: new Date().toISOString(),
    failedGate: failed?.gate ?? null,
    gates: results,
    durationMs: Math.round(performance.now() - start),
    hint: failed
      ? buildHint(results)
      : executed
        ? null
        : "[pipeline] no gates executed, check gates config and --max-cost",
  };
}
