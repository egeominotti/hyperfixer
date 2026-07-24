import { describe, expect, test } from "bun:test";
import { applyChanged } from "../src/changed.ts";
import type { GateSpec } from "../src/types.ts";

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
