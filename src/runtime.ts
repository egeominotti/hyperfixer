/**
 * Portability layer: everything runtime-specific lives here, implemented on
 * node: builtins so the same code runs on Node >= 20, Bun and Deno 2. Process
 * spawning lives in spawn.ts and is re-exported, so this stays the one door.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type { SpawnCapture } from "./spawn.ts";
export { spawnCapture, spawnSyncCapture } from "./spawn.ts";

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Age of a file by mtime, Infinity when it is gone. Used to judge leftovers
 * whose content says nothing about their owner: only age can tell a leftover
 * from a file some live run is about to use.
 */
export function fileAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Write to stdout and resolve only once the bytes reached the OS. console.log
 * to a pipe is buffered: returning before the flush lets the process exit with
 * a large verdict truncated at the pipe buffer, which is the machine-readable
 * interface silently producing invalid JSON.
 */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function readBytes(path: string): Buffer {
  return readFileSync(path);
}

export function writeTextFile(path: string, content: string): void {
  const dir = dirname(path);
  if (dir !== "" && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}

export function sha256(): ReturnType<typeof createHash> {
  return createHash("sha256");
}

export async function readStdin(): Promise<string> {
  // Interactive terminal means nothing is piped: never block waiting.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Filesystems without hard links (FAT, some network mounts) report these. */
const NO_LINK_SUPPORT = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]);

/**
 * Publish content at path only if absent. True when we created it.
 *
 * Write to a sibling then hard link it into place, rather than an exclusive
 * open followed by a write: link fails when the path exists, and the file is
 * never observable in a half written state, so a reader cannot mistake a live
 * writer's empty file for a corrupt leftover. Where the filesystem has no hard
 * links, fall back to the exclusive open: it is weaker, briefly observable as
 * empty, which is exactly why leftovers are judged by age and not by content.
 */
export function writeTextFileExclusive(path: string, content: string): boolean {
  return publishExclusive(path, content, linkSync);
}

/** The body of writeTextFileExclusive, with the linker injected for tests. */
export function publishExclusive(
  path: string,
  content: string,
  link: (from: string, to: string) => void,
): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeTextFile(tmp, content);
    link(tmp, path);
    return true;
  } catch (e) {
    if (!NO_LINK_SUPPORT.has(String((e as { code?: string }).code))) return false;
    try {
      writeFileSync(path, content, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  } finally {
    deleteFile(tmp);
  }
}

export function deleteFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** Best effort liveness probe; unknown errors count as alive (conservative). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}
