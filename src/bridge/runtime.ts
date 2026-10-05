import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
  workspaceIds?: string[];
  sharedMode?: boolean;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

/** Allowlisted metadata from the existing signal-zero PID probe, never its message or stack. */
export interface PidProbeError {
  code?: string;
  errno?: number;
  syscall?: string;
}

export type BridgeObservation = (
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" }
) & { pidProbeError?: PidProbeError };

function observePid(pid: number): { state: "present" | "missing" | "unknown"; error?: PidProbeError } {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unknown" };
  try {
    process.kill(pid, 0);
    return { state: "present" };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    const diagnostic: PidProbeError = {
      ...(typeof failure?.code === "string" ? { code: failure.code } : {}),
      ...(typeof failure?.errno === "number" && Number.isFinite(failure.errno) ? { errno: failure.errno } : {}),
      ...(typeof failure?.syscall === "string" ? { syscall: failure.syscall } : {}),
    };
    return {
      state: failure?.code === "ESRCH" ? "missing" : "unknown",
      ...(Object.keys(diagnostic).length > 0 ? { error: diagnostic } : {}),
    };
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */

export function listCandidateBridgePorts(): number[] {
  const ports = new Set<number>();
  const runtimeDir = path.join(getStateDir(), "runtime");
  if (fs.existsSync(runtimeDir)) {
    try {
      for (const file of fs.readdirSync(runtimeDir)) {
        if (!file.endsWith(".json")) continue;
        const entry = readJsonIfExists<RuntimeState>(path.join(runtimeDir, file));
        if (entry && typeof entry.port === "number" && entry.port > 0) {
          ports.add(entry.port);
        }
      }
    } catch {}
  }
  ports.add(DEFAULT_PORT);
  return [...ports];
}

export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  let runtime = readRuntimeState(workspaceId);
  if (!runtime) {
    const candidatePorts = listCandidateBridgePorts();
    for (const port of candidatePorts) {
      const health = await probeBridge(port);
      if (health && (health.workspaceId === workspaceId || health.workspaceIds?.includes(workspaceId))) {
        const refreshed = readRuntimeState(workspaceId);
        if (refreshed) {
          return { state: "healthy", runtime: refreshed };
        }
      }
    }
    return { state: "stopped", runtime: null, reason: "runtime_missing" };
  }

  const health = await probeBridge(runtime.port);
  if (health && (health.workspaceId === workspaceId || health.workspaceIds?.includes(workspaceId))) {
    return { state: "healthy", runtime };
  }
  if (health) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  const diagnostic = pid.error ? { pidProbeError: pid.error } : {};
  if (pid.state === "missing") return { state: "stopped", runtime, reason: "pid_missing", ...diagnostic };
  return { state: "unknown", runtime, reason: pid.state === "unknown" ? "pid_unknown" : "probe_failed", ...diagnostic };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
