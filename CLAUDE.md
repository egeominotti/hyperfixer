# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

hyperfixer — layered verification pipeline for AI-agent-written code. Runs quality gates (lint → typecheck → type tests → unit → property-based → parity → mutation) in cost order, fail-fast, and emits a machine-readable verdict (`.hyperfixer/verdict.json`) that agents consume to self-correct.

## Commands

```bash
bun install                  # install dependencies
bun run check                # full self-verification pipeline (the canonical check)
bun test                     # all tests
bun test test/property       # property-based tests only
bunx tsc --noEmit            # typecheck
bunx biome check --write .   # lint + format (autofix)
bun src/cli.ts run           # run the CLI from source
```

**Before declaring any change done, run `bun run check` — it must exit 0.**

## Architecture

Zero runtime dependencies. Bun-first (uses `Bun.spawn`, `Bun.file`, `Bun.write`).

```
src/
  types.ts      # all shared types (GateSpec, GateResult, Verdict, Finding)
  config.ts     # config load/validate + DEFAULT_GATES (the canonical gate list)
  parsers.ts    # tsc / bun-test output → structured Finding[]
  runner.ts     # pipeline: cost-sort, execute, fail-fast, build hint
  report.ts     # human rendering (colors) + verdict.json read/write
  colors.ts     # minimal ANSI helpers (NO_COLOR / TTY aware)
  commands.ts   # CLI command implementations (run, init, hint, doctor)
  cli.ts        # entry point: arg parsing + dispatch only
  index.ts      # public API surface
test/
  *.test.ts             # unit tests
  property/             # fast-check invariant tests
  types/                # expect-type + @ts-expect-error type tests
```

Data flow: `cli.ts` → `commands.ts` → `loadConfig` → `runPipeline(config, executor)` → `Verdict` → `report.ts`. The executor is injected (`GateExecutor`) so tests never spawn real processes.

## Hard rules

- **Max 200 lines per file.** Split before you exceed it.
- **No runtime dependencies.** Dev-only: typescript, biome, fast-check, expect-type.
- **tsconfig is maximally strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Never weaken flags; fix the code instead. No non-null assertions in `src/` (Biome enforces).
- **Every behavior change needs a test.** Runner/config logic gets a unit test; anything touching verdict shape must keep the property tests in `test/property/` passing.
- **Public API changes** must update `src/index.ts` and the type tests in `test/types/`.
- New gates go in `DEFAULT_GATES` (src/config.ts) with a cost reflecting real execution expense; parsers for new tools go in `src/parsers.ts` with fixture-based tests.
