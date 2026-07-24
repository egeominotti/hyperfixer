import type { Finding } from "./types.ts";

/**
 * Extract the first balanced JSON value ([ or {) from mixed tool output,
 * tolerant of banners before and warnings after the JSON itself.
 */
export function extractJson(output: string): unknown {
  const start = output.search(/[[{]/);
  if (start === -1) return null;
  const open = output[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < output.length; i++) {
    const c = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(output.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface EslintMessage {
  line?: number;
  column?: number;
  message?: string;
  ruleId?: string | null;
  severity?: number;
}

/** ESLint --format json: [{ filePath, messages: [...] }] */
export function parseEslintJson(output: string): Finding[] {
  const data = extractJson(output);
  if (!Array.isArray(data)) return [];
  const findings: Finding[] = [];
  const push = (filePath: string, m: EslintMessage) => {
    if (typeof m.message !== "string") return;
    const f: Finding = {
      file: filePath,
      message: m.ruleId ? `${m.message} (${m.ruleId})` : m.message,
    };
    if (typeof m.line === "number") f.line = m.line;
    if (typeof m.column === "number") f.column = m.column;
    if (typeof m.ruleId === "string") f.code = m.ruleId;
    findings.push(f);
  };
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { filePath?: unknown; messages?: unknown };
    if (typeof e.filePath !== "string" || !Array.isArray(e.messages)) continue;
    const errors = e.messages.filter((m: EslintMessage) => m?.severity === 2);
    const rest = e.messages.filter((m: EslintMessage) => m?.severity !== 2);
    for (const m of [...errors, ...rest]) push(e.filePath, m as EslintMessage);
  }
  return findings;
}

/**
 * Generic protocol: any tool (or a thin wrapper) can print a JSON array of
 * findings, or an object with a "findings" array, in hyperfixer's own shape.
 * This is the escape hatch that integrates every toolchain without a
 * dedicated parser.
 */
export function parseFindingsJson(output: string): Finding[] {
  const data = extractJson(output);
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { findings?: unknown }).findings)
      ? (data as { findings: unknown[] }).findings
      : null;
  if (list === null) return [];
  const findings: Finding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const i = item as Record<string, unknown>;
    if (typeof i.message !== "string") continue;
    const f: Finding = { message: i.message };
    if (typeof i.file === "string") f.file = i.file;
    if (typeof i.line === "number") f.line = i.line;
    if (typeof i.column === "number") f.column = i.column;
    if (typeof i.code === "string") f.code = i.code;
    findings.push(f);
  }
  return findings;
}
