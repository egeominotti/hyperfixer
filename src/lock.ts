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

interface LockPayload {
  pid?: unknown;
  at?: unknown;
  nonce?: unknown;
}

function readLock(path: string): LockPayload {
  try {
    return JSON.parse(readTextFile(path)) as LockPayload;
  } catch {
    return {};
  }
}

/**
 * One pipeline run per repo at a time: concurrent runs would race on
 * verdict.json and cache.json. Atomic acquire via exclusive create. Release
 * is ownership-aware (nonce match), so a release after our lock was stolen
 * never deletes another run's lock. Steal only removes the exact stale
 * content it judged, so a contender that lost the race backs off.
 */
export function acquireLock(outDir: string): LockResult {
  const path = `${outDir}/lock`;
  const nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const payload = `${JSON.stringify({ pid: process.pid, at: Date.now(), nonce })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeTextFileExclusive(path, payload)) {
      return {
        ok: true,
        release: () => {
          if (readLock(path).nonce === nonce) deleteFile(path);
        },
      };
    }
    const holder = readLock(path);
    const pid = typeof holder.pid === "number" ? holder.pid : null;
    const age = Date.now() - (typeof holder.at === "number" ? holder.at : 0);
    const alive = pid !== null && processAlive(pid);
    if (!alive || age > LOCK_MAX_AGE_MS) {
      // Delete only if the file still holds the stale content we judged:
      // if another contender already replaced it, back off.
      if (readLock(path).nonce === holder.nonce) deleteFile(path);
      continue;
    }
    return { ok: false, holderPid: pid };
  }
  return { ok: false, holderPid: null };
}
