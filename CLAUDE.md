# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

hyperfixer, layered verification pipeline for AI-agent-written code. Runs quality gates (lint, typecheck, type tests, unit, property-based, parity, mutation) in cost order, fail-fast, and emits a machine-readable verdict (`.hyperfixer/verdict.json`) that agents consume to self-correct.

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

**Before declaring any change done, run `bun run check`, it must exit 0.**

## Architecture

Zero runtime dependencies. Cross-runtime: node builtins only, everything runtime-specific goes through `src/runtime.ts` (Node >= 20, Bun, Deno 2).

```
src/
  types.ts      # all shared types (GateSpec, GateResult, Verdict, Finding)
  config.ts     # config load/validate + DEFAULT_GATES (the canonical gate list)
  parsers.ts    # tsc / bun-test output to structured Finding[]
  runtime.ts    # portability layer (fs, hash, stdin), node builtins only
  spawn.ts      # spawn half of the portability layer, re-exported by runtime.ts
  glob.ts       # minimal portable glob
  lock.ts       # one run per repo, atomic lock with stale steal
  runner.ts     # pipeline: cost groups in parallel, timeout, fail-fast, hint, exit codes
  cache.ts      # content-hash cache, caching executor, pipeline fingerprint
  changed.ts    # {changed} token expansion from git status
  report.ts     # human rendering (colors) + verdict.json read/write with validation
  colors.ts     # minimal ANSI helpers (NO_COLOR / TTY aware)
  commands.ts   # CLI command implementations (run, init, hint)
  fix.ts        # hyperfixer fix, run fixCommands then verify
  doctor.ts     # toolchain and config health checks
  parsers-json.ts # eslint-json and generic findings-json parsers
  initgen.ts    # smart init: stack detection, tailored gate list
  inputs.ts     # derive a gate's cache inputs from the tree
  claude.ts     # Claude Code integration (install-claude, claude-hook)
  hooks.ts      # git hook installer (pre-commit, pre-push)
  cli.ts        # entry point: arg parsing + dispatch only
  index.ts      # public API surface
test/
  *.test.ts             # unit tests
  property/             # fast-check invariant tests
  types/                # expect-type + @ts-expect-error type tests
.github/workflows/ci.yml  # verify on push, auto patch bump + CHANGELOG on green main
```

Data flow: `cli.ts` to `commands.ts` to `loadConfig` to `runPipeline(config, executor)` to `Verdict` to `report.ts`. The executor is injected (`GateExecutor`) so tests never spawn real processes.

## Hard rules

- **Max 200 lines per file.** Split before you exceed it.
- **No dashes in prose.** Use commas in docs, CLI output and messages.
- **No runtime dependencies.** Dev-only: typescript, biome, fast-check, expect-type.
- **tsconfig is maximally strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Never weaken flags; fix the code instead. No non-null assertions in `src/` (Biome enforces).
- **Every behavior change needs a test.** Runner/config logic gets a unit test; anything touching verdict shape must keep the property tests in `test/property/` passing.
- **Public API changes** must update `src/index.ts`, the type tests in `test/types/` and the README verdict schema.
- **Exit-code contract is sacred**: 0 pass, 1 code failure, 2 setup problem (config, empty pipeline, lock), 3 gate infrastructure failure. Agents branch on it; never let a config or infra error surface as exit 1.
- New gates go in `DEFAULT_GATES` (src/config.ts) with a cost reflecting real execution expense; parsers for new tools go in `src/parsers.ts` with fixture-based tests.
- Versioning is automated: CI bumps the patch version and CHANGELOG on green `main`. Never bump `package.json` version by hand.
