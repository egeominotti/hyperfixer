import { dim, green, red } from "./colors.ts";
import { cmdRun, type RunFlags } from "./commands.ts";
import { loadConfig } from "./config.ts";
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
  let gates: Awaited<ReturnType<typeof loadConfig>>["gates"];
  try {
    gates = (await loadConfig(flags.configPath)).gates;
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  const fixers = gates.filter(
    (g) => g.enabled !== false && g.fixCommand !== undefined && g.fixCommand.length > 0,
  );
  if (fixers.length === 0) {
    console.log(dim("no gate declares a fixCommand, nothing to autofix"));
  }
  for (const gate of fixers) {
    const command = gate.fixCommand as string[];
    try {
      const res = await spawnCapture(command, {
        timeoutMs: gate.timeoutMs ?? FIX_TIMEOUT_MS,
        killGraceMs: KILL_GRACE_MS,
      });
      if (res.exitCode === 0) {
        console.log(`${green("✓")} fix ${gate.name}`);
      } else {
        console.log(
          `${red("✗")} fix ${gate.name}${dim(`, exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}`)}`,
        );
      }
    } catch (e) {
      console.log(
        `${red("✗")} fix ${gate.name}${dim(`, ${e instanceof Error ? e.message : String(e)}`)}`,
      );
    }
  }
  return cmdRun(flags);
}
