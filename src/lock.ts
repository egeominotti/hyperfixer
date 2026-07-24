import {
  deleteFile,
  fileAgeMs,
  processAlive,
  readTextFile,
  writeTextFileExclusive,
} from "./runtime.ts";

const LOCK_MAX_AGE_MS = 15 * 60_000;
/**
 * A lock whose payload says nothing about its owner is judged by file age
 * alone, never by its content: only age can tell a leftover from something a
 * live run is about to use.
 */
const UNREADABLE_MAX_AGE_MS = 30_000;
/** Same reasoning for the steal guard, which is held for a handful of syscalls. */
const STEAL_GUARD_MAX_AGE_MS = 30_000;

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holderPid: number | null };

interface LockPayload {
  pid?: unknown;
  at?: unknown;
  nonce?: unknown;
}

/** Raw bytes of the lock, null when it is gone or unreadable. */
function readRaw(path: string): string | null {
  try {
    return readTextFile(path);
  } catch {
    return null;
  }
}

function parseLock(raw: string | null): LockPayload {
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as LockPayload;
  } catch {
    return {};
  }
}

/**
 * Liveness decides whenever the holder pid is readable: a run legitimately
 * slower than LOCK_MAX_AGE_MS must never be dispossessed while it is still
 * running. Age is the fallback for a lock that says nothing about its owner.
 */
function isStale(path: string, holder: LockPayload): boolean {
  const pid = holder.pid;
  if (typeof pid === "number") return !processAlive(pid);
  const at = holder.at;
  if (typeof at === "number") return Date.now() - at > LOCK_MAX_AGE_MS;
  return fileAgeMs(path) > UNREADABLE_MAX_AGE_MS;
}

/**
 * Take the steal guard, so only one contender at a time removes a stale lock.
 * The guard is judged by mtime, never by its content: an empty guard can be
 * one written by hand, or one left by a filesystem with no hard links, and
 * treating it as abandoned would let a stealer delete another's live guard,
 * which is the race the guard exists to prevent.
 */
function claimGuard(guard: string): boolean {
  const payload = `${JSON.stringify({ pid: process.pid })}\n`;
  if (writeTextFileExclusive(guard, payload)) return true;
  if (fileAgeMs(guard) <= STEAL_GUARD_MAX_AGE_MS) return false;
  deleteFile(guard);
  return writeTextFileExclusive(guard, payload);
}

/**
 * Remove a lock judged stale, serialized behind the guard. Judging and
 * unlinking are two syscalls, so without serialization two contenders can
 * both judge the same stale lock and the slower one then deletes the winner's
 * freshly created lock, leaving two runs live at once. Under the guard the
 * file is compared byte for byte against what was judged, which identifies it
 * because a lock is normally published whole (see writeTextFileExclusive) and
 * carries a unique nonce, so a lock that appeared in the meantime does not
 * compare equal.
 */
function stealStale(path: string, judged: string | null): void {
  const guard = `${path}.steal`;
  if (!claimGuard(guard)) return;
  try {
    if (readRaw(path) === judged) deleteFile(path);
  } finally {
    deleteFile(guard);
  }
}

/**
 * One pipeline run per repo at a time: concurrent runs would race on
 * verdict.json and cache.json. Atomic acquire via exclusive create. Release
 * is ownership-aware (nonce match), so a release after our lock was stolen
 * never deletes another run's lock.
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
          if (parseLock(readRaw(path)).nonce === nonce) deleteFile(path);
        },
      };
    }
    const raw = readRaw(path);
    const holder = parseLock(raw);
    if (!isStale(path, holder)) {
      return { ok: false, holderPid: typeof holder.pid === "number" ? holder.pid : null };
    }
    stealStale(path, raw);
  }
  return { ok: false, holderPid: null };
}
