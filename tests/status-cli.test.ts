import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeFile, writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

describe("c2c status PID probe diagnostics", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function fixture(fields: Record<string, unknown>) {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("status-pid-workspace");
    const fixtureDir = makeTmpDir("status-pid-preload");
    dirs.push(stateDir, root, fixtureDir);
    const workspace = new Workspace(root);
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: 68757,
      port: 1,
      adminToken: "private-runtime-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    writeRuntimeState(runtime);
    const runtimePath = runtimeFile(workspace.id);
    const before = fs.readFileSync(runtimePath, "utf8");
    const callsFile = path.join(fixtureDir, "calls.jsonl");
    const preload = write(fixtureDir, "probe-error.mjs", `
      import fs from "node:fs";
      process.kill = (pid, signal) => {
        fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ pid, signal }) + "\\n");
        throw Object.assign(new Error("private diagnostic message"), {
          ...${JSON.stringify(fields)},
          path: "/private/path", adminToken: "private-error-token", stack: "private diagnostic stack",
        });
      };
    `);
    return {
      run(command = "status") {
        return spawnSync(process.execPath, ["--import", preload, "--import", "tsx", cliEntry,
          command, "--workspace", root, "--json"], {
          cwd: projectRoot, encoding: "utf8", env: process.env,
        });
      },
      assertReadOnly() {
        expect(fs.readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)))
          .toEqual([{ pid: runtime.pid, signal: 0 }]);
        expect(fs.readFileSync(runtimePath, "utf8")).toBe(before);
        expect(fs.existsSync(path.join(stateDir, "logs"))).toBe(false);
      },
    };
  }

  it.each([
    { code: "EPERM", errno: -1, payload: { ok: false, running: null, state: "unknown", reason: "pid_unknown" } },
    { code: "ESRCH", errno: -3, payload: { ok: false, running: false } },
  ])("adds only allowlisted existing error fields to $code status JSON", ({ code, errno, payload }) => {
    const test = fixture({ code, errno, syscall: "kill" });
    const result = test.run();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ...payload, pidProbeError: { code, errno, syscall: "kill" },
    });
    expect(result.stdout).not.toContain("private");
    test.assertReadOnly();
  });

  it("preserves existing status JSON when no supported probe metadata exists", () => {
    const test = fixture({ code: { secret: "private-code" }, errno: "EPERM", syscall: ["private-syscall"] });
    const result = test.run();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false, running: null, state: "unknown", reason: "pid_unknown",
    });
    test.assertReadOnly();
  });

  it("keeps start refusal after an EPERM probe and leaves runtime intact", () => {
    const test = fixture({ code: "EPERM", errno: -1, syscall: "kill" });
    const result = test.run("start");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false, error: "Bridge state is uncertain (pid_unknown); refusing to start another bridge.",
    });
    test.assertReadOnly();
  });
});
