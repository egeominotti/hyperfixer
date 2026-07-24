import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateHash } from "../src/cache.ts";
import { globSync } from "../src/glob.ts";
import { detectGates } from "../src/initgen.ts";
import { SOURCE_EXT } from "../src/inputs.ts";
import type { GateSpec } from "../src/types.ts";

/** detectGates reads the working directory, so every case runs inside one. */
async function inDir(
  files: Record<string, string>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hyperfixer-detect-"));
  const prev = process.cwd();
  try {
    for (const [name, content] of Object.entries(files)) {
      await Bun.write(join(dir, name), content);
    }
    process.chdir(dir);
    await fn();
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectGates", () => {
  test("a bun project gets bun commands", async () => {
    await inDir({ "bun.lock": "", "tsconfig.json": "{}" }, () => {
      const { gates, detected } = detectGates();
      expect(detected).toContain("bun test");
      const unit = gates.find((g) => g.name === "unit");
      expect(unit?.command).toEqual(["bun", "test"]);
      expect(gates.find((g) => g.name === "typecheck")?.command?.[0]).toBe("bunx");
    });
  });

  test("a node project without bun gets npx commands", async () => {
    await inDir(
      { "package.json": '{"scripts":{"test":"jest"}}', "tsconfig.json": "{}" },
      () => {
        const { gates } = detectGates();
        expect(gates.find((g) => g.name === "typecheck")?.command?.[0]).toBe("npx");
        expect(gates.find((g) => g.name === "unit")?.command).toEqual(["npm", "test"]);
      },
    );
  });

  // The fallback used to hand back the bun-speaking defaults verbatim, so a
  // project without bun got a config whose every command failed to spawn,
  // which the pipeline reports as exit 3 on the very first run.
  test("the nothing-detected fallback speaks the runner the project has", async () => {
    await inDir({ "README.md": "# nothing to detect\n" }, () => {
      const { gates, detected } = detectGates();
      expect(detected).toEqual([]);
      const enabled = gates.filter((g) => g.enabled !== false);
      expect(enabled.length).toBeGreaterThan(0);
      for (const gate of enabled) {
        expect(gate.command?.[0]).not.toBe("bunx");
        expect(gate.command?.[0]).not.toBe("bun");
      }
      expect(gates.find((g) => g.name === "unit")?.command).toEqual(["npm", "test"]);
    });
  });

  test("lint gates use the scoped package name, not the squatted one", async () => {
    await inDir({ "biome.json": "{}", "bun.lock": "" }, () => {
      const lint = detectGates().gates.find((g) => g.name === "lint");
      expect(lint?.command).toEqual(["bunx", "@biomejs/biome", "check", "."]);
      expect(lint?.fixCommand).toContain("@biomejs/biome");
    });
  });

  // A pattern that resolves to nothing contributes nothing to the cache key,
  // so a gate carrying one caches on a key blind to part of its own inputs.
  test("every declared input resolves, so no gate gets a partial cache key", async () => {
    const files = {
      "biome.json": "{}",
      "tsconfig.json": "{}",
      "bun.lock": "",
      "src/a.ts": "export {}\n",
      "test/a.test.ts": "export {}\n",
    };
    await inDir(files, () => {
      const { gates } = detectGates();
      expect(gates.length).toBeGreaterThan(0);
      for (const gate of gates) {
        expect(gateHash(gate)).not.toBeNull();
        for (const pattern of gate.inputs ?? []) {
          expect(globSync(pattern).length).toBeGreaterThan(0);
        }
      }
    });
  });

  // Hardcoding src and test would key the cache on files a lib project does
  // not have, and a key blind to every source file replays a stale pass.
  test("a project laid out under lib is keyed on lib, not on a dead src", async () => {
    await inDir({ "tsconfig.json": "{}", "lib/a.ts": "export {}\n" }, () => {
      const typecheck = detectGates().gates.find((g) => g.name === "typecheck");
      expect(typecheck?.inputs).toContain("lib/**");
      expect(typecheck?.inputs).not.toContain("src/**");
      expect(gateHash(typecheck as GateSpec)).not.toBeNull();
    });
  });

  // The property that matters, on every layout: no source file may sit outside
  // the generated patterns, because the cache key is built from them alone.
  const layouts: Record<string, Record<string, string>> = {
    "sources at the root": { "index.ts": "export {}\n", "test/a.test.ts": "export {}\n" },
    "src plus scripts": { "src/a.ts": "export {}\n", "scripts/b.ts": "export {}\n" },
    "app plus e2e": { "app/a.tsx": "export {}\n", "e2e/b.spec.ts": "export {}\n" },
    "an unlisted directory": { "weird/a.mts": "export {}\n" },
    "a monorepo": { "packages/one/src/a.ts": "export {}\n" },
  };
  for (const [name, files] of Object.entries(layouts)) {
    test(`inputs cover every source file: ${name}`, async () => {
      await inDir({ ...files, "tsconfig.json": "{}" }, () => {
        const typecheck = detectGates().gates.find((g) => g.name === "typecheck");
        const covered = new Set((typecheck?.inputs ?? []).flatMap((p) => globSync(p)));
        const sources = globSync("**").filter((f) => SOURCE_EXT.test(f));
        expect(sources.length).toBeGreaterThan(0);
        expect(sources.filter((f) => !covered.has(f))).toEqual([]);
      });
    });
  }

  // Build output is derived from tracked sources, so keying on it invalidates
  // every gate on every rebuild, exactly when the cache is worth having.
  test("build output stays out of the key", async () => {
    const files = {
      "tsconfig.json": "{}",
      "src/a.ts": "export {}\n",
      "dist/a.js": "export {}\n",
      "coverage/report.js": "export {}\n",
      "generated/g.ts": "export {}\n",
      ".gitignore": "dist/\ncoverage\n# a comment\ngenerated\n",
    };
    await inDir(files, () => {
      const inputs = detectGates().gates.find((g) => g.name === "typecheck")?.inputs;
      expect(inputs).toContain("src/**");
      for (const out of ["dist/**", "coverage/**", "generated/**"]) {
        expect(inputs).not.toContain(out);
      }
    });
  });

  // No sources at all means no inputs, so the gate is never cached: better to
  // re-run every time than to cache on a key that cannot see any code.
  test("a project with no source file gets no inputs at all", async () => {
    await inDir({ "tsconfig.json": "{}", "docs/readme.md": "hi\n" }, () => {
      const typecheck = detectGates().gates.find((g) => g.name === "typecheck");
      expect(typecheck?.inputs).toBeUndefined();
      expect(gateHash(typecheck as GateSpec)).toBeNull();
    });
  });
});
