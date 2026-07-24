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

describe("e2e: install-claude", () => {
  test("creates settings, is idempotent, preserves existing keys", async () => {
    const dir = tempDir("hyperfixer-claude-");
    try {
      await Bun.write(join(dir, ".claude/settings.json"), '{"model":"opus"}');
      expect((await cli(dir, ["install-claude"])).exitCode).toBe(0);
      expect((await cli(dir, ["install-claude"])).exitCode).toBe(0);
      const settings = await Bun.file(join(dir, ".claude/settings.json")).json();
      expect(settings.model).toBe("opus");
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("claude-hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses corrupt settings with exit 2", async () => {
    const dir = tempDir("hyperfixer-claudebad-");
    try {
      await Bun.write(join(dir, ".claude/settings.json"), "{ nope");
      expect((await cli(dir, ["install-claude"])).exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e2e: claude-hook", () => {
  const payload = (command: string): string =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  test("non git-write commands pass through with exit 0", async () => {
    const dir = tempDir("hyperfixer-hookpass-");
    try {
      await writeGates(dir, [{ name: "boom", cost: 1, command: ["false"] }]);
      const r = await cli(dir, ["claude-hook"], payload("ls -la"));
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git commit with failing gates blocks with exit 2 and hint on stderr", async () => {
    const dir = tempDir("hyperfixer-hookblock-");
    try {
      await writeGates(dir, [{ name: "boom", cost: 1, command: ["false"] }]);
      const r = await cli(dir, ["claude-hook"], payload('git commit -m "x"'));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("[boom]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git push with green gates allows with exit 0", async () => {
    const dir = tempDir("hyperfixer-hookok-");
    try {
      await writeGates(dir, [{ name: "ok", cost: 1, command: ["true"] }]);
      const r = await cli(dir, ["claude-hook"], payload("git push origin main"));
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage stdin never blocks", async () => {
    const dir = tempDir("hyperfixer-hookgarbage-");
    try {
      const r = await cli(dir, ["claude-hook"], "not json at all");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e2e: smart init", () => {
  test("detects biome and typescript, generates matching gates", async () => {
    const dir = tempDir("hyperfixer-init-");
    try {
      await Bun.write(join(dir, "biome.json"), "{}");
      await Bun.write(join(dir, "tsconfig.json"), "{}");
      const r = await cli(dir, ["init"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("detected: biome, typescript");
      const config = await Bun.file(join(dir, "hyperfixer.config.json")).json();
      const names = config.gates.map((g: { name: string }) => g.name);
      expect(names).toEqual(["lint", "typecheck"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e2e: --changed", () => {
  test("expands {changed} and disables the gate when clean", async () => {
    const dir = tempDir("hyperfixer-changed-");
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      await writeGates(dir, [
        { name: "always", cost: 1, command: ["true"] },
        { name: "onchange", cost: 2, command: ["ls", "{changed}"] },
      ]);
      const dirty = await cli(dir, ["run", "--quiet", "--changed", "--no-cache"]);
      expect(dirty.exitCode).toBe(0);
      let verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
      expect(verdict.gates.map((g: { gate: string }) => g.gate)).toEqual([
        "always",
        "onchange",
      ]);

      Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
      Bun.spawnSync(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"],
        { cwd: dir },
      );
      const clean = await cli(dir, ["run", "--quiet", "--changed", "--no-cache"]);
      expect(clean.exitCode).toBe(0);
      verdict = await Bun.file(join(dir, ".hyperfixer/verdict.json")).json();
      expect(verdict.gates.map((g: { gate: string }) => g.gate)).toEqual(["always"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
