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

export async function loadCache(outDir: string): Promise<CacheFile> {
  const path = cachePath(outDir);
  if (!fileExists(path)) return {};
  try {
    const raw: unknown = JSON.parse(readTextFile(path));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as CacheFile;
  } catch {
    return {};
  }
}

export async function saveCache(outDir: string, cache: CacheFile): Promise<void> {
  writeTextFile(cachePath(outDir), `${JSON.stringify(cache)}\n`);
}

/**
 * Fingerprint a gate: command + parser + content of every file matched by its
 * input globs. Content-based, so touching a file or a checkout that rewrites
 * identical bytes never invalidates, and a real content change always does.
 * Gates without inputs return null, never cached.
 */
export function gateHash(gate: GateSpec, cwd = "."): string | null {
  const inputs = gate.inputs;
  if (!inputs || inputs.length === 0) return null;
  const hasher = sha256();
  hasher.update(JSON.stringify({ command: gate.command, parser: gate.parser }));
  const paths: string[] = [];
  for (const pattern of inputs) {
    paths.push(...globSync(pattern, cwd));
  }
  paths.sort();
  for (const path of paths) {
    hasher.update(`${path} `);
    try {
      hasher.update(readBytes(`${cwd}/${path}`));
    } catch {
      hasher.update("gone");
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
        return { ...entry.result, durationMs: 0, cached: true, note: "cache hit" };
      }
    }
    const result = await base(gate);
    if (hash !== null && result.status === "pass") {
      const { cached: _cached, note: _note, ...toStore } = result;
      cache[gate.name] = { hash, result: toStore };
    } else {
      delete cache[gate.name];
    }
    return result;
  };
}
