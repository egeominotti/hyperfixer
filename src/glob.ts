import { type Dirent, readdirSync, statSync } from "node:fs";

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && "\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function walkFiles(root: string, prefix: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(`${root}${prefix === "" ? "" : `/${prefix}`}`, {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Minimal glob over regular files, relative paths, dotfiles and node_modules
 * excluded. Supports "**", "*" and "?". Walks only the static prefix. A
 * pattern naming a directory yields nothing: callers hash file content, and a
 * directory would otherwise contribute a constant "unreadable" marker.
 */
export function globSync(pattern: string, cwd = "."): string[] {
  const segments = pattern.split("/");
  const wildIdx = segments.findIndex((s) => /[*?]/.test(s));
  if (wildIdx === -1) {
    return isFile(`${cwd}/${pattern}`) ? [pattern] : [];
  }
  const base = segments.slice(0, wildIdx).join("/");
  const files: string[] = [];
  walkFiles(cwd, base, files);
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f));
}
