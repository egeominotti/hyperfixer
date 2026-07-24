#!/usr/bin/env bun
import { cmdDoctor, cmdHint, cmdInit, cmdRun, type RunFlags } from "./commands.ts";
import { CONFIG_FILE } from "./config.ts";
import { cmdInstallHooks } from "./hooks.ts";

const USAGE = `hyperfixer, layered verification pipeline for agent-written code

Usage:
  hyperfixer run [flags]      run gates in cost order, write verdict, exit 0/1
  hyperfixer init             write default ${CONFIG_FILE}
  hyperfixer hint             print first actionable fix from last verdict
  hyperfixer doctor           check toolchain and config health
  hyperfixer install-hooks    install git pre-commit and pre-push hooks

Run flags:
  --json                machine-readable verdict on stdout
  --quiet               no human output (verdict.json still written)
  --config <path>       config file (default ${CONFIG_FILE})
  --only <a,b>          run only the named gates
  --max-cost <n>        run only gates with cost <= n
  --no-fail-fast        run all gates even after a failure
  --out-dir <dir>       verdict output directory (default .hyperfixer)

Exit codes: 0 pass, 1 gate failed, 2 usage/config error.`;

function parseRunFlags(args: string[]): RunFlags | null {
  const flags: RunFlags = {
    json: false,
    quiet: false,
    configPath: CONFIG_FILE,
    only: null,
    noFailFast: false,
    outDir: null,
    maxCost: null,
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
      case "--config": {
        const v = next();
        if (v === undefined) return null;
        flags.configPath = v;
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

function findConfigFlag(args: string[]): string {
  const i = args.indexOf("--config");
  const value = i === -1 ? undefined : args[i + 1];
  return value ?? CONFIG_FILE;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": {
      const flags = parseRunFlags(rest);
      return flags === null ? 2 : cmdRun(flags);
    }
    case "init":
      return cmdInit();
    case "hint":
      return cmdHint(findConfigFlag(rest));
    case "doctor":
      return cmdDoctor(findConfigFlag(rest));
    case "install-hooks":
      return cmdInstallHooks();
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

let exitCode: number;
try {
  exitCode = await main(Bun.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  exitCode = 2;
}
process.exit(exitCode);
