import { chmodSync } from "node:fs";
import { bold, green, red } from "./colors.ts";
import { fileExists, readTextFile, spawnSyncCapture, writeTextFile } from "./runtime.ts";

const MARKER = "# installed by hyperfixer";

function hookScript(maxCost: number | null): string {
  const flag = maxCost === null ? "" : ` --max-cost ${maxCost}`;
  return [
    "#!/bin/sh",
    MARKER,
    "# pick whichever js runtime this machine has",
    'if command -v bunx >/dev/null 2>&1; then HX="bunx hyperfixer";',
    'elif command -v npx >/dev/null 2>&1; then HX="npx --yes hyperfixer";',
    'elif command -v deno >/dev/null 2>&1; then HX="deno run -A npm:hyperfixer";',
    'else echo "hyperfixer: no js runtime found" >&2; exit 1; fi',
    `$HX run --quiet${flag} || { $HX hint; exit 1; }`,
    "",
  ].join("\n");
}

/** Resolve the real hooks dir via git, correct for worktrees and submodules. */
function gitHooksDir(): string | null {
  const res = spawnSyncCapture(["git", "rev-parse", "--git-path", "hooks"]);
  if (res.exitCode !== 0) return null;
  const dir = res.stdout.trim();
  return dir === "" ? null : dir;
}

async function installHook(
  hooksDir: string,
  name: string,
  maxCost: number | null,
): Promise<{ line: string; untouched: boolean }> {
  const path = `${hooksDir}/${name}`;
  if (fileExists(path)) {
    const current = readTextFile(path);
    if (!current.includes(MARKER)) {
      return {
        line: `${red("✗")} ${name}: existing hook not written by hyperfixer, left untouched`,
        untouched: true,
      };
    }
  }
  writeTextFile(path, hookScript(maxCost));
  chmodSync(path, 0o755);
  return { line: `${green("✓")} ${name}: ${path}`, untouched: false };
}

/**
 * Install git hooks: pre-commit runs cheap gates (cost <= 50),
 * pre-push runs the full pipeline. Idempotent, never clobbers foreign hooks.
 */
export async function cmdInstallHooks(): Promise<number> {
  const hooksDir = gitHooksDir();
  if (hooksDir === null) {
    console.error(red("not a git repository, run from the repo root"));
    return 2;
  }
  let results: Awaited<ReturnType<typeof installHook>>[];
  try {
    results = [
      await installHook(hooksDir, "pre-commit", 50),
      await installHook(hooksDir, "pre-push", null),
    ];
  } catch (e) {
    console.error(
      red(`hook install failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return 2;
  }
  for (const r of results) console.log(r.line);
  const partial = results.some((r) => r.untouched);
  if (partial) {
    console.error("warning: partial install, replace the foreign hook manually");
  }
  console.log(
    `${bold("done")}, commits run gates with cost <= 50, pushes run everything`,
  );
  return partial ? 1 : 0;
}
