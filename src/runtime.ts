/**
 * Portability layer: everything runtime-specific lives here, implemented on
 * node: builtins so the same code runs on Node >= 20, Bun and Deno 2.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), opts.killGraceMs);
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && "\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function walkFiles(root: string, prefix: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(`${root}${prefix === "" ? "" : `/${prefix}`}`, {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * Minimal glob over regular files, relative paths, dotfiles excluded.
 * Supports "**", "*" and "?". Walks only the static prefix of the pattern.
 */
export function globSync(pattern: string, cwd = "."): string[] {
  const segments = pattern.split("/");
  const wildIdx = segments.findIndex((s) => /[*?]/.test(s));
  if (wildIdx === -1) {
    return existsSync(`${cwd}/${pattern}`) ? [pattern] : [];
  }
  const base = segments.slice(0, wildIdx).join("/");
  const files: string[] = [];
  walkFiles(cwd, base, files);
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f));
}
