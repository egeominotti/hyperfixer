import {
  deleteFile,
  processAlive,
  readTextFile,
  writeTextFileExclusive,
} from "./runtime.ts";

const LOCK_MAX_AGE_MS = 15 * 60_000;

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holderPid: number | null };

/**
 * One pipeline run per repo at a time: two concurrent runs would race on
 * verdict.json and cache.json, and hint could read the other run's verdict.
 * Atomic acquire via exclusive create; stale locks (dead pid or older than
 * 15 min) are stolen.
 */
export function acquireLock(outDir: string): LockResult {
  const path = `${outDir}/lock`;
  const payload = `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeTextFileExclusive(path, payload)) {
      return { ok: true, release: () => deleteFile(path) };
    }
    let holder: { pid?: unknown; at?: unknown } = {};
    try {
      holder = JSON.parse(readTextFile(path)) as typeof holder;
    } catch {}
    const pid = typeof holder.pid === "number" ? holder.pid : null;
    const age = Date.now() - (typeof holder.at === "number" ? holder.at : 0);
    const alive = pid !== null && processAlive(pid);
    if (!alive || age > LOCK_MAX_AGE_MS) {
      deleteFile(path);
      continue;
    }
    return { ok: false, holderPid: pid };
  }
  return { ok: false, holderPid: null };
}
