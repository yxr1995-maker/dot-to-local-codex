import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
describe("local task review CLI", () => {
  it("refuses a noninteractive decision even when accept was supplied in argv", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "local-tasks", "review", "--thread-id", "one", "--request-id", "number:77", "--decision", "accept"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("interactive terminal");
  });
});
