export type GateStatus = "pass" | "fail" | "skip" | "error";

/** A single actionable problem, normalized so an agent can jump to it. */
export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
}

export interface GateResult {
  gate: string;
  status: GateStatus;
  durationMs: number;
  exitCode: number | null;
  findings: Finding[];
  /** Raw tail of combined output, for context when findings parsing is incomplete. */
  outputTail: string;
  /** Why the gate was skipped or errored, when applicable. */
  note?: string;
  /** True when this result was served from the input-hash cache. */
  cached?: boolean;
}

export type ParserKind =
  | "tsc"
  | "bun-test"
  | "fast-check"
  | "eslint-json"
  | "findings-json"
  | "raw";

export interface GateSpec {
  name: string;
  /** Relative cost; gates run in ascending order. */
  cost: number;
  /** Command argv. Missing/empty command => gate skipped. */
  command?: string[];
  /** Skip (instead of error) when the command cannot start or is absent. */
  optional?: boolean;
  parser?: ParserKind;
  enabled?: boolean;
  /** Kill the gate process after this many ms. Default 600000 (10 min). */
  timeoutMs?: number;
  /**
   * Glob patterns of the files this gate depends on. Only gates that declare
   * inputs are cacheable: unchanged inputs let a previous pass be reused.
   */
  inputs?: string[];
  /** Autofix command run by "hyperfixer fix" before re-verifying. */
  fixCommand?: string[];
}

export interface HyperfixerConfig {
  gates: GateSpec[];
  /** Stop at first failing gate. Default true. */
  failFast: boolean;
  /** Directory where verdict.json is written. Default ".hyperfixer". */
  outDir: string;
}

export interface Verdict {
  ok: boolean;
  /** ISO timestamp of when this verdict was produced. Guards against stale reads. */
  generatedAt: string;
  /**
   * Combined content hash of every gate's inputs at run time. hint compares
   * it against the current tree: a mismatch proves the verdict is stale.
   */
  inputsFingerprint?: string;
  /** Name of the first gate that failed or errored, null when ok. */
  failedGate: string | null;
  gates: GateResult[];
  durationMs: number;
  /** One-line, agent-consumable summary of what to fix first. */
  hint: string | null;
}

export type GateExecutor = (gate: GateSpec) => Promise<GateResult>;
