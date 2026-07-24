/**
 * Process spawning half of the portability layer, node builtins only so the
 * same code runs on Node >= 20, Bun and Deno 2. Reached through runtime.ts,
 * split out only to keep both files inside the size limit.
 */
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Hard cap on captured output per stream. Without it a chatty gate grows the
 * accumulator until the runtime string limit throws inside a stream handler,
 * outside any promise, crashing the CLI with no verdict and an orphaned lock.
 */
const MAX_CAPTURE_CHARS = 32 * 1024 * 1024;

export interface SpawnCapture {
  exitCode: number | null;
  /** Signal that killed the process, null when it exited on its own. */
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when output hit MAX_CAPTURE_CHARS and the rest was dropped. */
  truncated: boolean;
}

/**
 * Spawn argv (no shell), capture output, SIGTERM at the timeout then SIGKILL.
 * Settles at most timeoutMs + 2 * killGraceMs after the start: waiting for
 * close alone is unbounded, because close needs every inherited pipe closed
 * and a grandchild that escaped the process group can hold one open forever.
 */
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
    // StringDecoder: a multi-byte character split across pipe chunks must
    // not decode to replacement chars in findings the agent will act on.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = () => {
      for (const t of timers) clearTimeout(t);
    };
    // Clamps to the cap rather than stopping once it is passed, so the cap is
    // a bound a caller can rely on and not merely the point where we noticed.
    const capped = (buffer: string, chunk: string): string => {
      const room = MAX_CAPTURE_CHARS - buffer.length;
      if (chunk.length <= room) return buffer + chunk;
      truncated = true;
      if (room <= 0) return buffer;
      const kept = chunk.slice(0, room);
      // Never end on a lone high surrogate: the decoder went to some trouble
      // to keep characters whole, and the cap should not undo it.
      const last = kept.charCodeAt(kept.length - 1);
      return buffer + (last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept);
    };
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      stop();
      stdout = capped(stdout, outDec.end());
      stderr = capped(stderr, errDec.end());
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode, signal, stdout, stderr, timedOut, truncated });
    };
    // No "already exited" guard on the timer: close fires only once every
    // inherited pipe is closed too, so a backgrounded grandchild holding
    // stdout would otherwise keep the gate running well past its timeout.
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        timers.push(
          setTimeout(() => {
            killTree("SIGKILL");
            // Nothing left to wait for: the process group is gone and only an
            // escaped grandchild can still be holding the pipe.
            timers.push(setTimeout(() => settle(null, null), opts.killGraceMs));
          }, opts.killGraceMs),
        );
      }, opts.timeoutMs),
    );
    child.stdout?.on("data", (d: Buffer) => {
      stdout = capped(stdout, outDec.write(d));
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = capped(stderr, errDec.write(d));
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      stop();
      reject(e);
    });
    child.on("close", (exitCode, signalCode) => settle(exitCode, signalCode));
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
