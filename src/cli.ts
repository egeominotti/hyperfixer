#!/usr/bin/env bun
import { cmdDoctor, cmdHint, cmdInit, cmdRun, type RunFlags } from "./commands.ts";
import { CONFIG_FILE } from "./config.ts";

const USAGE = `hyperfixer — layered verification pipeline for agent-written code

Usage:
  hyperfixer run [flags]      run gates in cost order, write verdict, exit 0/1
  hyperfixer init             write default ${CONFIG_FILE}
  hyperfixer hint             print first actionable fix from last verdict
  hyperfixer doctor           check toolchain and config health

Run flags:
  --json                machine-readable verdict on stdout
  --quiet               no human output (verdict.json still written)
  --config <path>       config file (default ${CONFIG_FILE})
  --only <a,b>          run only the named gates
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

process.exit(await main(Bun.argv.slice(2)));
