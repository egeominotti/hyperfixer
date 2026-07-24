import { parseOutput } from "./parsers.ts";
import type {
  GateExecutor,
  GateResult,
  GateSpec,
  HyperfixerConfig,
  Verdict,
} from "./types.ts";

const TAIL_CHARS = 4000;

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
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const combined = out + (err ? `\n${err}` : "");
    const findings = parseOutput(gate.parser ?? "raw", combined);
    return {
      gate: gate.name,
      status: exitCode === 0 ? "pass" : "fail",
      durationMs: Math.round(performance.now() - start),
      exitCode,
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
      ? `${first.file}${first.line !== undefined ? `:${first.line}` : ""} — `
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

  const results: GateResult[] = [];
  let blocked = false;
  for (const gate of gates) {
    if (blocked) {
      results.push(skippedResult(gate, "earlier gate failed"));
      continue;
    }
    const result = await exec(gate);
    results.push(result);
    if (config.failFast && (result.status === "fail" || result.status === "error")) {
      blocked = true;
    }
  }

  const failed = results.find((r) => r.status === "fail" || r.status === "error");
  return {
    ok: failed === undefined,
    failedGate: failed?.gate ?? null,
    gates: results,
    durationMs: Math.round(performance.now() - start),
    hint: buildHint(results),
  };
}
