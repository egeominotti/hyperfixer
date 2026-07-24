import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli.ts");

async function cli(
  cwd: string,
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function writeGates(dir: string, gates: unknown[]): Promise<void> {
  await Bun.write(
    join(dir, "hyperfixer.config.json"),
    JSON.stringify({ failFast: true, outDir: ".hyperfixer", gates }),
  );
}
describe("e2e: doctor", () => {
  // Everything doctor inspects is setup, so a failure is exit 2: a 1 would
  // tell an agent its code is wrong when the toolchain is what is broken.
  test("input globs that resolve to nothing are reported, exit 2", async () => {
    const dir = tempDir("hyperfixer-doctor-");
    try {
      await Bun.write(join(dir, "src/a.ts"), "export {}\n");
      // Brace expansion is not supported, so this pattern matches no file and
      // the gate would be silently uncacheable.
      await writeGates(dir, [
        { name: "g", cost: 1, command: ["true"], inputs: ["src/**/*.{ts,tsx}"] },
      ]);
      const bad = await cli(dir, ["doctor"]);
      expect(bad.exitCode).toBe(2);
      expect(bad.stdout).toContain("inputs match no file");

      await writeGates(dir, [
        { name: "g", cost: 1, command: ["true"], inputs: ["src/**"] },
      ]);
      const good = await cli(dir, ["doctor"]);
      expect(good.exitCode).toBe(0);
      expect(good.stdout).toContain("all checks passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a config named with --config that does not exist is exit 2", async () => {
    const dir = tempDir("hyperfixer-doctorcfg-");
    try {
      const r = await cli(dir, ["doctor", "--config", "nope.json"]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("config file not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e2e: flag handling", () => {
  // init takes no flags. Accepting one and ignoring it would let a user think
  // "init --config other.json" wrote where they asked.
  test("a command that takes no arguments refuses one instead of ignoring it", async () => {
    const dir = tempDir("hyperfixer-noflags-");
    try {
      const r = await cli(dir, ["init", "--config", "other.json"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("takes no arguments");
      expect(await Bun.file(join(dir, "hyperfixer.config.json")).exists()).toBe(false);
      // Without flags it still works.
      expect((await cli(dir, ["init"])).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config aware commands still reject an unknown flag", async () => {
    const dir = tempDir("hyperfixer-badflag-");
    try {
      const r = await cli(dir, ["run", "--bogus"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An unknown command must say so, and help must not be turned into an error
  // by whatever the caller happened to append.
  test("an unknown command reports itself, help stays help", async () => {
    const dir = tempDir("hyperfixer-unknown-");
    try {
      const bogus = await cli(dir, ["bogus", "--json"]);
      expect(bogus.exitCode).toBe(2);
      expect(bogus.stderr).toContain("unknown command: bogus");
      const help = await cli(dir, ["--help", "--json"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
