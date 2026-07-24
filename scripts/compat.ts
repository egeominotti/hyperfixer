/**
 * Cross-runtime compat gate: build dist/, then smoke-test the built CLI on
 * every JS runtime present on this machine (node, deno; bun runs src daily).
 * Exit 1 on any failure, skip runtimes that are not installed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncCapture } from "../src/runtime.ts";

function run(label: string, argv: string[], cwd?: string): void {
  const res = spawnSyncCapture(argv, cwd);
  if (res.exitCode !== 0) {
    console.error(`compat: ${label} failed (exit ${res.exitCode})\n${res.stdout}`);
    process.exit(1);
  }
  console.log(`compat: ${label} ok`);
}

const has = (tool: string): boolean =>
  spawnSyncCapture([tool, "--version"]).exitCode === 0;

run("build (tsc)", ["bunx", "tsc", "-p", "tsconfig.build.json"]);

const cliJs = `${process.cwd()}/dist/cli.js`;
const fixture = mkdtempSync(join(tmpdir(), "hyperfixer-compat-"));
writeFileSync(
  join(fixture, "hyperfixer.config.json"),
  JSON.stringify({
    failFast: true,
    outDir: ".hyperfixer",
    gates: [{ name: "smoke", cost: 1, command: ["true"] }],
  }),
);

// init walks the tree and reads .gitignore, so it exercises fs paths the
// smoke run never touches. It writes a config, so give it its own directory.
const initDir = mkdtempSync(join(tmpdir(), "hyperfixer-compat-init-"));
writeFileSync(join(initDir, "tsconfig.json"), "{}");
writeFileSync(join(initDir, "src/a.ts".replace("src/", "")), "export {}\n");

try {
  if (has("node")) {
    run("node --help", ["node", cliJs, "--help"]);
    run("node run fixture", ["node", cliJs, "run", "--quiet"], fixture);
    run("node init", ["node", cliJs, "init"], initDir);
  } else {
    console.log("compat: node not installed, skipped");
  }
  if (has("deno")) {
    run("deno --help", ["deno", "run", "--allow-all", cliJs, "--help"]);
    run("deno run fixture", ["deno", "run", "--allow-all", cliJs, "run", "--quiet"], fixture);
    rmSync(join(initDir, "hyperfixer.config.json"), { force: true });
    run("deno init", ["deno", "run", "--allow-all", cliJs, "init"], initDir);
  } else {
    console.log("compat: deno not installed, skipped");
  }
  if (has("bun")) {
    run("bun dist --help", ["bun", cliJs, "--help"]);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(initDir, { recursive: true, force: true });
}
console.log("compat: all installed runtimes green");
