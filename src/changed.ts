import type { GateSpec } from "./types.ts";

export const CHANGED_TOKEN = "{changed}";

/**
 * Working-tree changes vs HEAD, staged, unstaged and untracked. Null outside
 * git. Uses -z (NUL separators): paths with spaces or unicode arrive verbatim,
 * no C-quoting to undo.
 */
export function changedFiles(): string[] | null {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain", "-z"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (res.exitCode !== 0) return null;
    const tokens = res.stdout.toString().split("\0");
    const files: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (entry === undefined || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      files.push(entry.slice(3));
      // Renames/copies carry the origin path as the next NUL field, skip it.
      if (status.includes("R") || status.includes("C")) i++;
    }
    return files;
  } catch {
    return null;
  }
}

/**
 * Expand the {changed} token in gate commands to the changed file list.
 * A gate that references {changed} is disabled when nothing changed,
 * gates without the token are untouched.
 */
export function applyChanged(gates: GateSpec[], files: string[]): GateSpec[] {
  return gates.map((g) => {
    if (!g.command?.includes(CHANGED_TOKEN)) return g;
    if (files.length === 0) return { ...g, enabled: false };
    return {
      ...g,
      command: g.command.flatMap((a) => (a === CHANGED_TOKEN ? files : [a])),
    };
  });
}
