/**
 * Portability layer: everything runtime-specific lives here, implemented on
 * node: builtins so the same code runs on Node >= 20, Bun and Deno 2.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface SpawnCapture {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn argv (no shell), capture output, SIGTERM at timeout then SIGKILL. */
export function spawnCapture(
  command: string[],
  opts: { timeoutMs: number; killGraceMs: number },
): Promise<SpawnCapture> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      reject(new Error("empty command"));
      return;
    }
    // detached puts the gate in its own process group on POSIX, so the
    // timeout can kill the whole tree, grandchildren included.
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const killTree = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-pid, signal);
          return;
        } catch {}
      }
      child.kill(signal);
    };
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return;
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), opts.killGraceMs);
    }, opts.timeoutMs);
    // StringDecoder: a multi-byte character split across pipe chunks must
    // not decode to replacement chars in findings the agent will act on.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += outDec.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += errDec.write(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      stdout += outDec.end();
      stderr += errDec.end();
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

/** Synchronous spawn for quick checks (git status, tool --version). */
export function spawnSyncCapture(
  command: string[],
  cwd?: string,
): { exitCode: number | null; stdout: string } {
  const [cmd, ...args] = command;
  if (cmd === undefined) return { exitCode: null, stdout: "" };
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { exitCode: null, stdout: "" };
  return { exitCode: res.status, stdout: res.stdout ?? "" };
}

export function fileExists(path: string): boolean {
  return existsSync(path);
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

/** Create the file only if absent. True when created, false when it exists. */
export function writeTextFileExclusive(path: string, content: string): boolean {
  const dir = dirname(path);
  if (dir !== "" && dir !== ".") mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, content, { flag: "wx" });
    return true;
  } catch {
    return false;
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
