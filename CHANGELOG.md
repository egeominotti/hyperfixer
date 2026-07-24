# Changelog

All notable changes to hyperfixer are documented here. The format follows [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org). Release sections below are appended automatically by CI on every green build of `main`.

## [Unreleased]

## [0.1.2] - 2026-07-24

- fix: push release tag explicitly and atomically
- feat: production hardening, e2e suite, CI auto-release

## [0.1.1] - 2026-07-24

- feat: production hardening, e2e suite, CI auto-release

## [0.1.0] - 2026-07-24

### Added

- Gate pipeline: cost-ordered execution, fail-fast, injected executor
- Gates: lint (Biome), typecheck (tsc), typetest (expect-type), unit, pbt (fast-check), parity, mutation (Stryker, opt-in)
- Machine-readable verdict (`.hyperfixer/verdict.json`) with structured findings, `generatedAt` timestamp and one-line `hint`
- Output parsers for `tsc` and `bun test`
- CLI: `run`, `init`, `hint`, `doctor`, `install-hooks`
- Run flags: `--json`, `--quiet`, `--config`, `--only`, `--max-cost`, `--no-fail-fast`, `--out-dir`
- Per-gate timeout (default 10 min), duplicate gate name validation, stale verdict warning
- Git hooks installer: pre-commit (cost <= 50), pre-push (full pipeline)
