import { globSync } from "./glob.ts";
import { fileExists, readBytes, readTextFile, sha256, writeTextFile } from "./runtime.ts";
import type { GateExecutor, GateResult, GateSpec } from "./types.ts";

interface CacheEntry {
  hash: string;
  result: GateResult;
}

export type CacheFile = Record<string, CacheEntry>;

function cachePath(outDir: string): string {
  return `${outDir}/cache.json`;
}

function isGateResult(value: unknown): value is GateResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.gate === "string" &&
    (r.status === "pass" ||
      r.status === "fail" ||
      r.status === "skip" ||
      r.status === "error") &&
    typeof r.durationMs === "number" &&
    (typeof r.exitCode === "number" || r.exitCode === null) &&
    Array.isArray(r.findings) &&
    r.findings.every(isFinding) &&
    (r.findingsTotal === undefined || typeof r.findingsTotal === "number") &&
    typeof r.outputTail === "string"
  );
}

function isFinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.message !== "string") return false;
  // Optional fields are replayed into the verdict typed, so a wrong type here
  // would surface as a Finding that lies about its own shape.
  const optional: [unknown, string][] = [
    [f.file, "string"],
    [f.code, "string"],
    [f.line, "number"],
    [f.column, "number"],
  ];
  return optional.every(([v, kind]) => v === undefined || typeof v === kind);
}

/**
 * The cache is replayed straight into the verdict, so an entry that does not
 * match the GateResult shape (hand edited, half written, produced by an older
 * version) would surface as a malformed green result. Validate on read and
 * drop anything that does not conform: a dropped entry only costs a re-run.
 */
export async function loadCache(outDir: string): Promise<CacheFile> {
  const path = cachePath(outDir);
  if (!fileExists(path)) return {};
  try {
    const raw: unknown = JSON.parse(readTextFile(path));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const clean: CacheFile = {};
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.hash !== "string" || !isGateResult(e.result)) continue;
      clean[name] = { hash: e.hash, result: e.result };
    }
    return clean;
  } catch {
    return {};
  }
}

export async function saveCache(outDir: string, cache: CacheFile): Promise<void> {
  writeTextFile(cachePath(outDir), `${JSON.stringify(cache)}\n`);
}

/**
 * Fingerprint a gate: command + parser + input patterns + content of every
 * file they match. Content-based, so touching a file or a checkout that
 * rewrites identical bytes never invalidates, and a real content change
 * always does.
 *
 * Returns null (never cached) when the gate declares no inputs, and also when
 * its patterns match nothing: an unsupported pattern such as a brace
 * expansion resolves to the empty set, and hashing the empty set would give a
 * constant digest that can never change, freezing the first pass forever.
 *
 * Every chunk is length delimited so the stream is injective: without it,
 * moving bytes between a path and the content that follows it produces the
 * same digest for two genuinely different trees.
 */
export function gateHash(gate: GateSpec, cwd = "."): string | null {
  const inputs = gate.inputs;
  if (!inputs || inputs.length === 0) return null;
  const paths = [...new Set(inputs.flatMap((pattern) => globSync(pattern, cwd)))].sort();
  if (paths.length === 0) return null;
  const hasher = sha256();
  const spec = JSON.stringify({
    command: gate.command,
    parser: gate.parser,
    inputs,
  });
  hasher.update(`${spec.length}\0${spec}\0`);
  for (const path of paths) {
    hasher.update(`${path.length}\0${path}\0`);
    try {
      const bytes = readBytes(`${cwd}/${path}`);
      hasher.update(`${bytes.length}\0`);
      hasher.update(bytes);
    } catch {
      hasher.update("gone\0");
    }
  }
  return hasher.digest("hex");
}

/**
 * Combined fingerprint of every enabled gate's inputs, null when no gate
 * declares inputs. Stored in the verdict so hint can prove staleness by
 * content instead of guessing by clock.
 */
export function pipelineFingerprint(gates: GateSpec[]): string | null {
  const parts = gates
    .filter((g) => g.enabled !== false)
    .map((g) => `${g.name}:${gateHash(g) ?? "-"}`);
  if (parts.every((p) => p.endsWith(":-"))) return null;
  const hasher = sha256();
  hasher.update(parts.join("|"));
  return hasher.digest("hex");
}

/**
 * Wrap an executor with input-hash caching. Only "pass" results are cached:
 * failures always re-run. A hit is returned instantly with cached: true.
 */
export function cachingExecutor(base: GateExecutor, cache: CacheFile): GateExecutor {
  return async (gate) => {
    const hash = gateHash(gate);
    if (hash !== null) {
      const entry = cache[gate.name];
      if (entry && entry.hash === hash && entry.result.status === "pass") {
        // Keep the stored note: "output truncated" and dropped findings still
        // describe the result being replayed, not the replay itself.
        const note = entry.result.note ? `${entry.result.note}, cache hit` : "cache hit";
        return { ...entry.result, durationMs: 0, cached: true, note };
      }
    }
    const result = await base(gate);
    if (hash !== null && result.status === "pass") {
      const { cached: _cached, ...toStore } = result;
      cache[gate.name] = { hash, result: toStore };
    } else {
      delete cache[gate.name];
    }
    return result;
  };
}
