# AGENTS.md

Instructions for AI coding agents (any vendor: Codex, Claude, Cursor, Kimi, Grok, others) working in this repository. Claude Code also reads `CLAUDE.md`; keep the two consistent.

## What this project is

hyperfixer is a layered verification pipeline for agent-written code: quality gates run in cost order (cheap to expensive), fail-fast, and produce `.hyperfixer/verdict.json`, a structured verdict with per-gate findings and a one-line `hint` naming the first thing to fix.

## Golden rule: verify with the tool itself

```bash
bun run check
```

This runs lint, typecheck, typetest, unit and pbt on this repo. It is the definition of done: **exit 0 or the change is not finished.** If it fails, `bun src/cli.ts hint` prints the first actionable problem (file:line).

## Setup

```bash
bun install          # Bun >= 1.1 required; there is no Node/npm path
```

## Verification commands (cheapest first)

| Command | Purpose |
|---|---|
| `bunx biome check --write .` | lint + format, autofix |
| `bunx tsc --noEmit` | strict typecheck |
| `bun test test/types` | public API type tests |
| `bun test` | full test suite |
| `bun test test/property` | fast-check invariants |
| `bun run check` | the whole pipeline (canonical) |

## Repository map

| Path | Contents | Notes |
|---|---|---|
| `src/types.ts` | Shared types | Verdict shape is public API |
| `src/config.ts` | Config load/validation, `DEFAULT_GATES` | Add new gates here |
| `src/parsers.ts` | Tool output to `Finding[]` | New parsers need fixture tests |
| `src/runner.ts` | Pipeline execution, timeout, fail-fast, hint | Executor injected for testability |
| `src/report.ts` | Human + JSON output, verdict validation | |
| `src/commands.ts` | CLI commands | |
| `src/hooks.ts` | Git hook installer | Never clobbers foreign hooks |
| `src/cli.ts` | Arg parsing + dispatch only | Keep logic out of here |
| `test/property/` | Verdict invariants (fast-check) | Must always pass |
| `test/types/` | expect-type + `@ts-expect-error` | Update on API changes |
| `.github/workflows/ci.yml` | CI: verify, then auto patch bump + CHANGELOG | Do not bump versions by hand |

## Constraints

1. **Max 200 lines per file**, split modules instead of growing them.
2. **No dashes in prose**, use commas in docs, CLI output and messages.
3. **Zero runtime dependencies**, the published package must stay dependency-free.
4. **Strictness is non-negotiable**, do not weaken `tsconfig.json` or `biome.json`; fix code to satisfy them. No `!` non-null assertions in `src/`.
5. **Exit-code contract is sacred**: 0 pass, 1 gate failed, 2 usage/config error. Agents branch on it.
6. **Tests accompany changes**: behavior change means unit test; verdict-shape change means property tests updated; API change means `src/index.ts` + type tests + README schema updated.
7. **Injected executor**: never make `runPipeline` spawn processes directly in tests; pass a fake `GateExecutor`.
8. **Conventional Commits** for commit messages; versioning and CHANGELOG are automated by CI on green `main`.

## Common tasks

- **Add a gate**: extend `DEFAULT_GATES` in `src/config.ts` (choose `cost` by real runtime), document it in `README.md`, add a config normalization test.
- **Add a parser**: implement in `src/parsers.ts`, register in `ParserKind` (`src/types.ts`) and `parseOutput`, add fixture tests in `test/parsers.test.ts`.
- **Change verdict shape**: update `src/types.ts`, property tests, type tests, and the README schema example, all in the same change.
