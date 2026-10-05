import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  writeRuntimeState,
  readRuntimeState,
  runtimeFile,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it.each([
    { code: "EPERM", errno: -1, state: "unknown", reason: "pid_unknown" },
    { code: "ESRCH", errno: -3, state: "stopped", reason: "pid_missing" },
  ])("retains only existing PID probe error fields for $code", async ({ code, errno, state, reason }) => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir(`obs-${code.toLowerCase()}`);
    dirs.push(root);
    const workspace = new Workspace(root);
    const runtime = stubRuntime(workspace.id, workspace.root, 68757, 1);
    writeRuntimeState(runtime);
    const before = fs.readFileSync(runtimeFile(workspace.id), "utf8");
    const probeError = Object.assign(new Error("private diagnostic message"), {
      code,
      errno,
      syscall: "kill",
      path: "/private/path",
      adminToken: "private-token",
      stack: "private diagnostic stack",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw probeError; });

    const observation = await findBridgeObservation(workspace.id);

    expect(observation).toEqual({
      state,
      runtime,
      reason,
      pidProbeError: { code, errno, syscall: "kill" },
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(runtime.pid, 0);
    expect(fs.readFileSync(runtimeFile(workspace.id), "utf8")).toBe(before);
    expect(readRuntimeState(workspace.id)).toEqual(runtime);

    if (code === "EPERM") {
      kill.mockClear();
      await expect(ensureBridge(root)).rejects.toThrow(
        "Bridge state is uncertain (pid_unknown); refusing to start another bridge."
      );
      expect(kill).toHaveBeenCalledExactlyOnceWith(runtime.pid, 0);
      expect(fs.readFileSync(runtimeFile(workspace.id), "utf8")).toBe(before);
      expect(fs.existsSync(path.join(process.env.C2C_STATE_DIR!, "logs"))).toBe(false);
    }
  });

  it("omits diagnostic fields when the existing probe throws no supported metadata", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unstructured-error");
    dirs.push(root);
    const workspace = new Workspace(root);
    const runtime = stubRuntime(workspace.id, workspace.root, 68757, 1);
    writeRuntimeState(runtime);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("private diagnostic message"), {
        code: { private: "private-token" }, errno: "EPERM", syscall: ["private-syscall"],
      });
    });

    expect(await findBridgeObservation(workspace.id)).toEqual({
      state: "unknown", runtime, reason: "pid_unknown",
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(runtime.pid, 0);
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });
});
