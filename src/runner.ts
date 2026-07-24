import { parseOutput } from "./parsers.ts";
import { spawnCapture } from "./runtime.ts";
import type {
  GateExecutor,
  GateResult,
  GateSpec,
  HyperfixerConfig,
  Verdict,
} from "./types.ts";

const TAIL_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

export const spawnExecutor: GateExecutor = async (gate) => {
  const start = performance.now();
  const command = gate.command ?? [];
  if (command.length === 0) {
    return {
      gate: gate.name,
      status: "skip",
      durationMs: 0,
      exitCode: null,
      findings: [],
      outputTail: "",
      note: "no command configured",
    };
  }
  try {
    const timeoutMs = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = await spawnCapture(command, { timeoutMs, killGraceMs: KILL_GRACE_MS });
    const combined = res.stdout + (res.stderr ? `\n${res.stderr}` : "");
    if (res.timedOut) {
      return {
        gate: gate.name,
        status: "error",
        durationMs: Math.round(performance.now() - start),
        exitCode: null,
        findings: [],
        outputTail: combined.slice(-TAIL_CHARS),
        note: `timed out after ${timeoutMs}ms`,
      };
    }
    const findings = parseOutput(gate.parser ?? "raw", combined);
    return {
      gate: gate.name,
      status: res.exitCode === 0 ? "pass" : "fail",
      durationMs: Math.round(performance.now() - start),
      exitCode: res.exitCode,
      findings,
      outputTail: combined.slice(-TAIL_CHARS),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      gate: gate.name,
      status: gate.optional ? "skip" : "error",
      durationMs: Math.round(performance.now() - start),
      exitCode: null,
      findings: [],
      outputTail: "",
      note: `command failed to start: ${message}`,
    };
  }
};

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

export function buildHint(results: GateResult[]): string | null {
  const blocking = results.find((r) => r.status === "fail" || r.status === "error");
  if (!blocking) return null;
  const first = blocking.findings[0];
  if (first) {
    const loc = first.file
      ? `${first.file}${first.line !== undefined ? `:${first.line}` : ""}, `
      : "";
    const more =
      blocking.findings.length > 1 ? ` (+${blocking.findings.length - 1} more)` : "";
    return `[${blocking.gate}] ${loc}${first.message}${more}`;
  }
  return `[${blocking.gate}] ${blocking.note ?? `exit code ${blocking.exitCode}`}`;
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
