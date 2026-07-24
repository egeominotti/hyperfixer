/**
 * Deriving a gate's cache inputs from the tree. Kept apart from stack
 * detection because the question it answers is different: not "what tool does
 * this project use" but "which files must the key see for a pass to be
 * trustworthy".
 */
import { globSync } from "./glob.ts";
import { fileExists, readTextFile } from "./runtime.ts";
import type { GateSpec } from "./types.ts";

export const SOURCE_EXT = /\.[cm]?[jt]sx?$/;
/** Build output, kept out of the key: rebuilding it must not invalidate. */
const OUTPUT_DIRS = ["dist", "build", "out", "coverage", "target", "vendor"];

/**
 * Top level names to leave out: whatever git is told to ignore, plus the usual
 * output directories. Their content is derived from tracked sources, so a real
 * change always shows up in the sources too, while keying on them would
 * invalidate every gate on every rebuild.
 */
function ignoredNames(): Set<string> {
  const names = new Set(OUTPUT_DIRS);
  if (!fileExists(".gitignore")) return names;
  for (const raw of readTextFile(".gitignore").split("\n")) {
    const line = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    if (!line.includes("/") && !line.includes("*")) names.add(line);
  }
  return names;
}

/**
 * Where this project keeps code, read off the tree instead of assumed. A fixed
 * list of directory names writes a key blind to every source file of a project
 * laid out differently, and a file the key cannot see is a change the cache
 * cannot see, which replays a stale pass forever.
 *
 * What this guarantees, exactly: every path globSync can see that matches
 * SOURCE_EXT, and is not under an ignored name, is under one of the patterns
 * returned, as of the moment init runs. It does not guarantee coverage of
 * files a gate reads for other reasons: data a test loads, a config a tool
 * follows by reference, a source directory added later. Those remain the
 * user's job, which is why the README asks for it and doctor checks what it
 * can. Empty when nothing matches, and a gate with no inputs is never cached.
 */
function sourceInputs(): string[] {
  const ignored = ignoredNames();
  const patterns = new Set<string>();
  for (const path of globSync("**")) {
    if (!SOURCE_EXT.test(path)) continue;
    const slash = path.indexOf("/");
    if (slash === -1) {
      patterns.add("*");
      continue;
    }
    const top = path.slice(0, slash);
    if (!ignored.has(top)) patterns.add(`${top}/**`);
  }
  return [...patterns].sort();
}

/**
 * Attach inputs only when sources were found, and only extra patterns that
 * resolve. Config files alone would be worse than nothing: the gate would
 * cache on a key blind to every source file it actually reads.
 */
export function withInputs(gate: GateSpec, extra: string[] = []): GateSpec {
  const sources = sourceInputs();
  if (sources.length === 0) return gate;
  return {
    ...gate,
    inputs: [...sources, ...extra.filter((p) => globSync(p).length > 0)],
  };
}
