import { dim, green, red } from "./colors.ts";
import { cmdRun, type RunFlags } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { acquireLock } from "./lock.ts";
import { spawnCapture } from "./runtime.ts";

const FIX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

/**
 * Run every enabled gate's declared fixCommand (biome --write, eslint --fix,
 * formatters), then re-verify with the normal pipeline. Autofixable noise
 * disappears before the agent ever sees it; only real errors reach the hint.
 * A failing fixer is reported and does not stop the others: the pipeline
 * afterwards is the arbiter.
 */
export async function cmdFix(flags: RunFlags): Promise<number> {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(flags.configPath, flags.configExplicit);
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  // Fixers mutate the tree: hold the same lock as run for the whole
  // fix-then-verify sequence, so no concurrent run reads a half-fixed tree.
  const lock = acquireLock(flags.outDir ?? config.outDir);
  if (!lock.ok) {
    console.error(
      red(
        `another hyperfixer run is in progress${lock.holderPid !== null ? ` (pid ${lock.holderPid})` : ""}, retry when it finishes`,
      ),
    );
    return 2;
  }
  try {
    return await runFixers(config.gates, flags);
  } finally {
    lock.release();
  }
}

async function runFixers(
  gates: Awaited<ReturnType<typeof loadConfig>>["gates"],
  flags: RunFlags,
): Promise<number> {
  const fixers = gates.filter(
    (g) =>
      g.enabled !== false &&
      g.fixCommand !== undefined &&
      g.fixCommand.length > 0 &&
      (flags.only === null || flags.only.includes(g.name)) &&
      (flags.maxCost === null || g.cost <= flags.maxCost),
  );
  // Fixer progress goes to stderr: stdout belongs to the verdict, and under
  // --json a single human line ahead of it makes the whole document
  // unparsable. stderr is a separate stream, so --json still gets diagnostics;
  // only --quiet, which asks for no human output at all, silences them.
  const progress = (line: string) => {
    if (!flags.quiet) console.error(line);
  };
  if (fixers.length === 0) {
    progress(dim("no gate declares a fixCommand, nothing to autofix"));
  }
  for (const gate of fixers) {
    const command = gate.fixCommand as string[];
    try {
      const res = await spawnCapture(command, {
        timeoutMs: gate.timeoutMs ?? FIX_TIMEOUT_MS,
        killGraceMs: KILL_GRACE_MS,
      });
      if (res.exitCode === 0) {
        progress(`${green("✓")} fix ${gate.name}`);
      } else {
        progress(
          `${red("✗")} fix ${gate.name}${dim(`, exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}`)}`,
        );
      }
    } catch (e) {
      progress(
        `${red("✗")} fix ${gate.name}${dim(`, ${e instanceof Error ? e.message : String(e)}`)}`,
      );
    }
  }
  return cmdRun(flags, { skipLock: true });
}
