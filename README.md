# hyperfixer

**Layered verification pipeline for AI-agent-written code.**

hyperfixer runs your project's quality gates in cost order — cheapest first, fail-fast — and produces a machine-readable verdict that a coding agent can consume to fix its own mistakes. Humans get a colored summary; agents get `verdict.json` and a one-line `hint` pointing at the first actionable problem.

```
✓ lint (64ms)
✓ typecheck (462ms)
✓ typetest (20ms)
✓ unit (22ms)
✓ pbt (32ms)

OK — all gates passed in 601ms
```

## Why

Agent-written code fails in layers, and each layer needs a different detector:

| Layer | Catches | Tool |
|---|---|---|
| Lint | Style drift, suspicious patterns | [Biome](https://biomejs.dev) |
| Typecheck | Type errors | `tsc --noEmit` (strict) |
| Type tests | Wrong public API types | [expect-type](https://github.com/mmkal/expect-type) + `@ts-expect-error` |
| Unit tests | Broken behavior | `bun test` |
| Property-based | Edge cases nobody thought to write | [fast-check](https://fast-check.dev) |
| Differential/parity | Two implementations disagreeing | project-defined oracle |
| Mutation | Tests that pass but assert nothing | [Stryker](https://stryker-mutator.io) |

Running everything on every change is wasteful; running only unit tests misses whole failure classes. hyperfixer orders gates by cost, stops at the first failure, and tells the agent exactly where to look — so the feedback loop is fast *and* honest.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1

## Quick start

```bash
bun add -d hyperfixer        # or clone this repo
bunx hyperfixer init         # writes hyperfixer.config.json
bunx hyperfixer doctor       # verify toolchain
bunx hyperfixer run          # run the pipeline
```

## CLI

```
hyperfixer run [flags]      run gates in cost order, write verdict, exit 0/1
hyperfixer init             write default hyperfixer.config.json
hyperfixer hint             print first actionable fix from last verdict
hyperfixer doctor           check toolchain and config health

Run flags:
  --json                machine-readable verdict on stdout
  --quiet               no human output (verdict.json still written)
  --config <path>       config file (default hyperfixer.config.json)
  --only <a,b>          run only the named gates
  --no-fail-fast        run all gates even after a failure
  --out-dir <dir>       verdict output directory (default .hyperfixer)
```

Exit codes: `0` all gates pass · `1` a gate failed · `2` usage or config error.

## Configuration

`hyperfixer.config.json`:

```json
{
  "failFast": true,
  "outDir": ".hyperfixer",
  "gates": [
    { "name": "lint",      "cost": 5,   "command": ["bunx", "biome", "check", "."] },
    { "name": "typecheck", "cost": 10,  "command": ["bunx", "tsc", "--noEmit"], "parser": "tsc" },
    { "name": "unit",      "cost": 30,  "command": ["bun", "test"], "parser": "bun-test" },
    { "name": "pbt",       "cost": 40,  "command": ["bun", "test", "test/property"], "parser": "bun-test" },
    { "name": "mutation",  "cost": 100, "command": ["bunx", "stryker", "run", "--incremental"], "enabled": false, "optional": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `cost` | Relative cost; gates run in ascending order |
| `command` | Argv array; omit to skip the gate |
| `parser` | `tsc`, `bun-test`, or `raw` — extracts structured findings from output |
| `optional` | Skip (instead of error) when the command cannot start |
| `enabled` | `false` removes the gate from the pipeline |

## Agent integration

The core loop an agent should run:

```bash
hyperfixer run --quiet || hyperfixer hint
# => [typecheck] src/service.ts:42 — Type 'string' is not assignable to type 'number'. (+3 more)
```

`hint` prints the first actionable problem with file and line; the full structured verdict is in `.hyperfixer/verdict.json`:

```jsonc
{
  "ok": false,
  "failedGate": "typecheck",
  "hint": "[typecheck] src/service.ts:42 — Type 'string' is not assignable…",
  "gates": [
    {
      "gate": "typecheck",
      "status": "fail",            // pass | fail | skip | error
      "durationMs": 458,
      "exitCode": 2,
      "findings": [
        { "file": "src/service.ts", "line": 42, "column": 5, "code": "TS2322", "message": "…" }
      ],
      "outputTail": "…"
    }
  ]
}
```

As a Claude Code [Stop hook](https://docs.anthropic.com/en/docs/claude-code/hooks), so every agent turn ends verified:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bunx hyperfixer run --quiet || bunx hyperfixer hint" }] }
    ]
  }
}
```

## Programmatic API

```ts
import { loadConfig, runPipeline } from "hyperfixer";

const verdict = await runPipeline(await loadConfig());
if (!verdict.ok) console.error(verdict.hint);
```

## Development

```bash
bun install
bun run check        # hyperfixer verifying itself (lint → typecheck → typetest → unit → pbt)
```

The repo dogfoods its own pipeline: property-based tests assert verdict invariants (`ok ⟺ no failing gate`, fail-fast skips everything after the first failure), and type tests pin the public API.

## License

MIT
