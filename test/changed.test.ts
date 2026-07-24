import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChanged, changedFiles } from "../src/changed.ts";
import type { GateSpec } from "../src/types.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, stdout: "ignore", stderr: "ignore" },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("changedFiles", () => {
  test("null outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-nogit-"));
    try {
      expect(changedFiles(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clean tree yields empty list", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-clean-"));
    try {
      git(dir, "init", "-q");
      expect(changedFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("modified, untracked and renamed paths, spaces preserved, origin dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperfixer-dirty-"));
    try {
      git(dir, "init", "-q");
      await Bun.write(join(dir, "a.ts"), "export {}");
      await Bun.write(join(dir, "old name.ts"), "export {}");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
      await Bun.write(join(dir, "a.ts"), "export const changed = 1;");
      await Bun.write(join(dir, "new file.ts"), "export {}");
      git(dir, "mv", "old name.ts", "renamed name.ts");
      const files = changedFiles(dir);
      expect(files).not.toBeNull();
      const sorted = [...(files ?? [])].sort();
      expect(sorted).toEqual(["a.ts", "new file.ts", "renamed name.ts"]);
      expect(sorted).not.toContain("old name.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyChanged", () => {
  const gate = (command: string[]): GateSpec => ({ name: "g", cost: 1, command });

  test("expands {changed} into the file list in place", () => {
    const out = applyChanged([gate(["eslint", "{changed}"])], ["a.ts", "b.ts"]);
    expect(out[0]?.command).toEqual(["eslint", "a.ts", "b.ts"]);
  });

  test("gate with {changed} and no changes is disabled", () => {
    const out = applyChanged([gate(["eslint", "{changed}"])], []);
    expect(out[0]?.enabled).toBe(false);
  });

  test("gate without the token is untouched", () => {
    const spec = gate(["bun", "test"]);
    const out = applyChanged([spec], ["a.ts"]);
    expect(out[0]).toBe(spec);
  });

  test("commandless gate is untouched", () => {
    const spec: GateSpec = { name: "g", cost: 1 };
    expect(applyChanged([spec], ["a.ts"])[0]).toBe(spec);
  });
});
