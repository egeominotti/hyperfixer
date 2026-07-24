#!/usr/bin/env node
import { cmdClaudeHook, cmdInstallClaude } from "./claude.ts";
import { cmdHint, cmdInit, cmdRun, type RunFlags } from "./commands.ts";
import { CONFIG_FILE } from "./config.ts";
import { cmdDoctor } from "./doctor.ts";
import { cmdFix } from "./fix.ts";
import { cmdInstallHooks } from "./hooks.ts";

const USAGE = `hyperfixer, layered verification pipeline for agent-written code

Usage:
  hyperfixer run [flags]      run gates in cost order, write verdict
  hyperfixer fix [flags]      run every gate's fixCommand, then verify
  hyperfixer init             detect the stack, write ${CONFIG_FILE}
  hyperfixer hint             print first actionable fix from last verdict
  hyperfixer doctor           check toolchain and config health
  hyperfixer install-hooks    install git pre-commit and pre-push hooks
  hyperfixer install-claude   install Claude Code PreToolUse hook
  hyperfixer claude-hook      internal, PreToolUse entry point (stdin JSON)

Run flags:
  --json                machine-readable verdict on stdout
  --quiet               no human output (verdict.json still written)
  --config <path>       config file (default ${CONFIG_FILE})
  --only <a,b>          run only the named gates
  --max-cost <n>        run only gates with cost <= n
  --changed             expand {changed} in commands to git-changed files
  --no-cache            ignore and do not update the input-hash cache
  --no-fail-fast        run all gates even after a failure
  --out-dir <dir>       verdict output directory (default .hyperfixer)

Exit codes:
  0 every gate that ran passed (--only and --max-cost make that a subset,
    the verdict lists what was held back in filteredGates)
  1 a gate failed, fix CODE, read the hint
  2 setup problem, config error, empty pipeline, lock held, fix SETUP
  3 gate infrastructure failed, timeout or tool crash, do NOT edit code`;

function parseRunFlags(args: string[]): RunFlags | null {
  const flags: RunFlags = {
    json: false,
    quiet: false,
    configPath: CONFIG_FILE,
    configExplicit: false,
    only: null,
    noFailFast: false,
    outDir: null,
    maxCost: null,
    noCache: false,
    changed: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;
    const next = () => {
      const v = args[++i];
      if (v === undefined) console.error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--json":
        flags.json = true;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "--no-fail-fast":
        flags.noFailFast = true;
        break;
      case "--no-cache":
        flags.noCache = true;
        break;
      case "--changed":
        flags.changed = true;
        break;
      case "--config": {
        const v = next();
        if (v === undefined) return null;
        flags.configPath = v;
        flags.configExplicit = true;
        break;
      }
      case "--only": {
        const v = next();
        if (v === undefined) return null;
        flags.only = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case "--out-dir": {
        const v = next();
        if (v === undefined) return null;
        flags.outDir = v;
        break;
      }
      case "--max-cost": {
        const v = next();
        if (v === undefined) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) {
          console.error(`--max-cost requires a number, got "${v}"`);
          return null;
        }
        flags.maxCost = n;
        break;
      }
      default:
        console.error(`unknown flag: ${arg}\n\n${USAGE}`);
        return null;
    }
  }
  return flags;
}

/** Commands that read the config, and so must agree on --config and --out-dir. */
const CONFIG_AWARE = new Set(["run", "fix", "hint", "doctor", "claude-hook"]);
/** Commands that take no arguments at all. */
const NO_ARGS = new Set(["init", "install-hooks", "install-claude"]);

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Every config-aware command parses the same flags: hint reading the default
  // out-dir while run wrote elsewhere would answer from another run's verdict.
  const aware = cmd !== undefined && CONFIG_AWARE.has(cmd);
  const flags = aware ? parseRunFlags(rest) : null;
  if (aware && flags === null) return 2;
  // Silently ignoring an argument would let a user believe that
  // "init --config other.json" wrote where they asked; it never does.
  const stray = cmd !== undefined && NO_ARGS.has(cmd) ? rest[0] : undefined;
  if (stray !== undefined) {
    console.error(`${cmd} takes no arguments, got ${stray}`);
    return 2;
  }
  switch (cmd) {
    case "run":
      return flags === null ? 2 : cmdRun(flags);
    case "fix":
      return flags === null ? 2 : cmdFix(flags);
    case "init":
      return cmdInit();
    case "hint":
      return flags === null ? 2 : cmdHint(flags);
    case "doctor":
      return flags === null ? 2 : cmdDoctor(flags);
    case "install-hooks":
      return cmdInstallHooks();
    case "install-claude":
      return cmdInstallClaude();
    case "claude-hook":
      return flags === null ? 2 : cmdClaudeHook(flags);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

try {
  // Setting exitCode instead of calling process.exit: on Node and Bun a pipe
  // is written asynchronously, and exiting outright discards whatever is still
  // queued, truncating --json output at the pipe buffer size.
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
