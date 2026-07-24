import { describe, expect, test } from "bun:test";
import { spawnCapture } from "../src/runtime.ts";

describe("spawnCapture process-group kill", () => {
  test("SIGTERM-ignoring child with grandchildren is bounded by the timeout", async () => {
    const start = performance.now();
    const res = await spawnCapture(["sh", "-c", "trap '' TERM; sleep 30 & sleep 30"], {
      timeoutMs: 150,
      killGraceMs: 150,
    });
    const elapsed = performance.now() - start;
    expect(res.timedOut).toBe(true);
    // Previously this hung for the full 30s because orphaned grandchildren
    // kept the pipes open. Group SIGKILL must bound it near timeout + grace.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  test("utf-8 characters split across writes decode intact", async () => {
    const res = await spawnCapture(
      ["sh", "-c", "printf '\\342\\202'; sleep 0.05; printf '\\254 done'"],
      { timeoutMs: 5_000, killGraceMs: 100 },
    );
    expect(res.stdout).toBe("€ done");
  });
});
