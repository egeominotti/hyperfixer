import { pipelineFingerprint } from "./cache.ts";
import { green, red } from "./colors.ts";
import type { RunFlags } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { acquireLock } from "./lock.ts";
import { writeVerdict } from "./report.ts";
import { exitCodeFor, runPipeline } from "./runner.ts";
import { fileExists, readStdin, readTextFile, writeTextFile } from "./runtime.ts";

const HOOK_COMMAND = "npx --yes hyperfixer claude-hook";
const SETTINGS_PATH = ".claude/settings.json";
// Matches git invocations whose subcommand is commit or push. Global flags
// between "git" and the subcommand are allowed, each optionally consuming one
// value token (-c k=v, -C /path, --git-dir /x), so flagged invocations cannot
// bypass verification while "git log; echo commit" stays unmatched.
const GIT_WRITE = /\bgit\s+(?:-\S+\s+(?:[^-]\S*\s+)?)*(commit|push)\b/;

/**
 * PreToolUse hook entry point. Reads the hook payload from stdin; when the
 * tool call is a git commit or push, runs the pipeline. Exit 2 blocks the
 * tool call and the stderr hint is fed back to the agent. Anything that is
 * not a git write exits 0 and never blocks.
 */
export async function cmdClaudeHook(flags: RunFlags): Promise<number> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (typeof payload !== "object" || payload === null) return 0;
  const p = payload as { tool_name?: unknown; tool_input?: { command?: unknown } };
  if (p.tool_name !== "Bash" || typeof p.tool_input?.command !== "string") return 0;
  if (!GIT_WRITE.test(p.tool_input.command)) return 0;

  // Fail closed on internal errors, but with a message the agent can act on.
  try {
    const config = await loadConfig(flags.configPath, flags.configExplicit);
    const outDir = flags.outDir ?? config.outDir;
    const lock = acquireLock(outDir);
    if (!lock.ok) {
      console.error("hyperfixer: another run is in progress, retry in a moment");
      return 2;
    }
    let verdict: Awaited<ReturnType<typeof runPipeline>>;
    try {
      const fingerprint = pipelineFingerprint(config.gates);
      verdict = await runPipeline(config);
      if (fingerprint !== null) verdict.inputsFingerprint = fingerprint;
      await writeVerdict(verdict, outDir);
    } finally {
      lock.release();
    }
    if (!verdict.ok) {
      const infra = exitCodeFor(verdict) === 3;
      console.error(
        infra
          ? `hyperfixer: gate infrastructure failed, not a code error: ${verdict.hint ?? "see verdict.json"}`
          : (verdict.hint ?? "hyperfixer gates failed, see verdict.json"),
      );
      return 2;
    }
    return 0;
  } catch (e) {
    console.error(
      `hyperfixer: cannot verify, fix this first: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

/**
 * Write (or merge into) .claude/settings.json a PreToolUse hook that runs
 * the pipeline before every git commit and push the agent attempts.
 * Idempotent: an existing hyperfixer entry is left as is.
 */
export async function cmdInstallClaude(): Promise<number> {
  let settings: Record<string, unknown> = {};
  if (fileExists(SETTINGS_PATH)) {
    try {
      const raw: unknown = JSON.parse(readTextFile(SETTINGS_PATH));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("settings root is not an object");
      }
      settings = raw as Record<string, unknown>;
    } catch (e) {
      console.error(red(`${SETTINGS_PATH} exists but is not valid JSON, fix it first`));
      console.error(String(e instanceof Error ? e.message : e));
      return 2;
    }
  }
  settings.hooks ??= {};
  if (
    typeof settings.hooks !== "object" ||
    settings.hooks === null ||
    Array.isArray(settings.hooks)
  ) {
    console.error(red("hooks exists but is not an object, fix it first"));
    return 2;
  }
  const hooks = settings.hooks as Record<string, unknown>;
  hooks.PreToolUse ??= [];
  const pre = hooks.PreToolUse as HookEntry[];
  if (!Array.isArray(pre)) {
    console.error(red("hooks.PreToolUse exists but is not an array, fix it first"));
    return 2;
  }
  const present = pre.some((entry) =>
    entry?.hooks?.some((h) => h?.command?.includes("hyperfixer claude-hook")),
  );
  if (!present) {
    pre.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    });
  }
  writeTextFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(
    `${green("✓")} ${SETTINGS_PATH}: PreToolUse hook ${present ? "already present" : "installed"}`,
  );
  console.log(
    "plain git commit and git push from the agent now require green gates (best effort, aliases and wrappers are not intercepted)",
  );
  return 0;
}
