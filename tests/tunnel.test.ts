import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { Logger } from "../src/logger/index.js";
import { startBridge } from "../src/bridge/server.js";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import { normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { resolveTunnelProtocol, tunnelProtocolArgs } from "../src/tunnel/protocol.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(
  fetchImpl: FetchImpl,
  startTimeoutMs = 1_000,
  logger = new Logger({ name: "tunnel-test", file: null, console: false, level: "debug" })
) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(logger, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, logger, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("classifies DNS probe failures and propagates the last probe reason through startup timeout", async () => {
    const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${new URL(QUICK_URL).hostname}`), {
      code: "ENOTFOUND",
    });
    const failure = new TypeError("fetch failed", { cause });
    const logger = new Logger({ name: "tunnel-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const { child, tunnel } = setupTunnel(async () => { throw failure; }, 30, logger);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out.*DNS.*ENOTFOUND/i);
    const probeLog = warn.mock.calls.find(([message]) => message.includes("public health probe failed"));
    expect(probeLog?.[1]).toMatchObject({
      classification: "dns",
      errorCode: "ENOTFOUND",
      hostname: new URL(QUICK_URL).hostname,
      method: "GET",
      path: "/health",
    });
    expect(JSON.stringify(probeLog)).not.toContain(QUICK_URL);
    expect(tunnel.status().detail).toMatch(/DNS.*ENOTFOUND/i);
    expect(error.mock.calls.find(([message]) => message.includes("startup timeout"))?.[1]).toMatchObject({
      lastProbeClassification: "dns",
      lastProbeCode: "ENOTFOUND",
      hostname: new URL(QUICK_URL).hostname,
      timeoutMs: 30,
    });
  });

  it("classifies TLS probe failures separately from DNS failures", async () => {
    const cause = Object.assign(new Error(`certificate name mismatch at ${QUICK_URL}`), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const failure = new TypeError("fetch failed", { cause });
    const logger = new Logger({ name: "tunnel-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const { child, tunnel } = setupTunnel(async () => { throw failure; }, 30, logger);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/TLS.*ERR_TLS_CERT_ALTNAME_INVALID/i);
    const probeLog = warn.mock.calls.find(([message]) => message.includes("public health probe failed"));
    expect(probeLog?.[1]).toMatchObject({ classification: "tls", errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(JSON.stringify(probeLog)).not.toContain(QUICK_URL);
    await tunnel.stop();
  });

  it("reports public health HTTP status separately from transport failures", async () => {
    const logger = new Logger({ name: "tunnel-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const { child, tunnel } = setupTunnel(async () => new Response(null, { status: 502 }), 30, logger);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/HTTP 502/i);
    const probeLog = warn.mock.calls.find(([message]) => message.includes("public health probe returned a non-ready response"));
    expect(probeLog?.[1]).toMatchObject({ classification: "http", hostname: new URL(QUICK_URL).hostname, status: 502 });
    await tunnel.stop();
  });

  it("drains final cloudflared output after timeout SIGTERM and closes readers only on close", async () => {
    const logger = new Logger({ name: "drain-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const { child, tunnel } = setupTunnel(async () => { throw new Error("fixture health unavailable"); }, 30, logger);
    let atKill: { stdoutDestroyed: boolean; stderrDestroyed: boolean } | undefined;
    let stderrDestroyedAtExit: boolean | undefined;
    child.kill.mockImplementation(() => {
      atKill = { stdoutDestroyed: child.stdout.destroyed, stderrDestroyed: child.stderr.destroyed };
      if (!child.stderr.destroyed) child.stderr.write("INF final transport output after stop request\n");
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      stderrDestroyedAtExit = child.stderr.destroyed;
      child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGTERM");
      return true;
    });
    const starting = tunnel.start(3333); announceUrl(child);
    await expect(starting).rejects.toThrow(/timed out/i);
    expect(atKill).toEqual({ stdoutDestroyed: false, stderrDestroyed: false });
    expect(stderrDestroyedAtExit).toBe(false);
    expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
    const closed = warn.mock.calls.find(([message]) => message === "cloudflared process closed");
    expect(closed?.[1]).toMatchObject({ stage: "cloudflared_process_close", signal: "SIGTERM", stopRequestedReason: "startup_timeout" });
    expect(JSON.stringify(closed)).toContain("final transport output after stop request");
  });

  it("retains a bounded redacted INFO tail with the registered transport and terminal cause", async () => {
    const logger = new Logger({ name: "tail-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const { child, tunnel } = setupTunnel(() => new Promise<Response>(() => {}), 1_000, logger);
    const starting = tunnel.start(3333); announceUrl(child);
    for (let n = 0; n < 150; n++) child.stderr.write(`INF diagnostic line ${n} ${"x".repeat(1500)}\n`);
    child.stderr.write("INF Registered tunnel connection connIndex=0 protocol=http2 ip=198.41.192.227\n");
    child.stderr.write('INF {"password":"hidden-password","api_key":"hidden-key"} sk-proj-' + "a".repeat(40) + '\n');
    child.exitCode = 1; child.emit("exit", 1, null); child.stdout.end(); child.stderr.end(); child.emit("close", 1, null);
    await expect(starting).rejects.toThrow(/exited/i);
    const details = warn.mock.calls.find(([message]) => message === "cloudflared process closed")?.[1] as { recentOutput: { stream: string; message: string }[]; stopRequestedReason: unknown };
    expect(details).toBeDefined(); expect(details.stopRequestedReason).toBeNull();
    expect(details.recentOutput.length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(JSON.stringify(details.recentOutput))).toBeLessThanOrEqual(32 * 1024);
    const captured = JSON.stringify(details.recentOutput);
    expect(captured).toContain("Registered tunnel connection"); expect(captured).toContain("protocol=http2");
    expect(captured).not.toContain("hidden-password"); expect(captured).not.toContain("hidden-key"); expect(captured).not.toContain("sk-proj-");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps stderr readable between spontaneous exit and close without inventing a requested stop", async () => {
    const logger = new Logger({ name: "exit-test", file: null, console: false, level: "debug" });
    const warn = vi.spyOn(logger, "warn");
    const { child, tunnel } = setupTunnel(() => new Promise<Response>(() => {}), 1_000, logger);
    const starting = tunnel.start(3333); announceUrl(child);
    child.exitCode = 1; child.emit("exit", 1, null);
    const readableAfterExit = !child.stderr.destroyed;
    if (readableAfterExit) child.stderr.write("INF terminal detail emitted before pipe close\n");
    child.stdout.end(); child.stderr.end(); child.emit("close", 1, null);
    await expect(starting).rejects.toThrow(/exited/i);
    expect(readableAfterExit).toBe(true); expect(child.kill).not.toHaveBeenCalled();
    const closed = warn.mock.calls.find(([message]) => message === "cloudflared process closed");
    expect(closed?.[1]).toMatchObject({ code: 1, signal: null, stopRequestedReason: null });
    expect(JSON.stringify(closed)).toContain("terminal detail emitted before pipe close");
  });

  it("does not let drained output from an old attempt overwrite a healthy new tunnel", async () => {
    const oldChild = new FakeCloudflaredProcess(), newChild = new FakeCloudflaredProcess();
    const nextUrl = "https://next-attempt-example.trycloudflare.com";
    let calls = 0;
    const tunnel = new CloudflaredQuickTunnel(undefined, "fixture", {
      spawnImpl: () => (++calls === 1 ? oldChild : newChild) as unknown as ChildProcess,
      startTimeoutMs: 30,
      fetchImpl: async input => String(input).startsWith(nextUrl) ? healthResponse() : new Response(null, { status: 503 }),
    });
    const first = tunnel.start(3333); announceUrl(oldChild);
    await expect(first).rejects.toThrow(/timed out/i);
    const second = tunnel.start(3333); newChild.stderr.write(`INF ${nextUrl}\n`);
    await expect(second).resolves.toBe(nextUrl);
    oldChild.stderr.write("ERR delayed old attempt failure\n");
    expect(tunnel.status()).toMatchObject({ running: true, url: nextUrl });
    expect(tunnel.status().detail).toBeUndefined();
    oldChild.exitCode = 1; oldChild.emit("exit", 1, null); oldChild.stdout.end(); oldChild.stderr.end(); oldChild.emit("close", 1, null);
    await tunnel.stop(); newChild.stdout.end(); newChild.stderr.end(); newChild.emit("close", null, "SIGTERM");
  });

  it("keeps the bridge healthy after a tunnel startup error instead of closing the origin", async () => {
    const root = makeTmpDir("tunnel-origin-lifecycle"); stateDirs.push(root);
    const fakeTunnel = {
      name: "fixture", start: async () => { throw new Error("fixture public health reset"); },
      stop: async () => {}, restart: async () => { throw new Error("fixture"); },
      status: () => ({ provider: "fixture", running: false, url: null }), getPublicUrl: () => null,
      doctor: async () => ({ provider: "fixture", binaryFound: true, binaryPath: null, running: false, url: null, problems: [] }),
    };
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: path.join(root, "auth.json"), tunnelProvider: fakeTunnel });
    try {
      const failed = await fetch(bridge.localBaseUrl() + "/admin/tunnel/start", { method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` } });
      expect(failed.status).toBe(500);
      const health = await fetch(bridge.localBaseUrl() + "/health");
      expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ service: "c2c-bridge", status: "ok", workspaceId: bridge.workspace.id });
    } finally { await bridge.close(); }
  });

  it("passes --protocol when C2C_TUNNEL_PROTOCOL is set", async () => {
    vi.stubEnv("C2C_TUNNEL_PROTOCOL", "http2");
    const { child, spawnImpl, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    await tunnel.stop();
    vi.unstubAllEnvs();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const logger = new Logger({ name: "tunnel-test", file: null, console: false, level: "debug" });
    const loggedError = vi.spyOn(logger, "error");
    const { child, tunnel } = setupTunnel(async () => new Response(null), 1_000, logger);
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(loggedError).toHaveBeenCalledWith("cloudflared process error", expect.objectContaining({
      stage: "cloudflared_process",
      errorCode: "ENOENT",
    }));
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("tunnel transport protocol", () => {
  it("keeps cloudflared's default when C2C_TUNNEL_PROTOCOL is unset or empty", () => {
    expect(resolveTunnelProtocol({})).toBeNull();
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "  " })).toBeNull();
    expect(tunnelProtocolArgs(null)).toEqual([]);
  });

  it("accepts the cloudflared protocol names case-insensitively", () => {
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "HTTP2" })).toBe("http2");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: " quic " })).toBe("quic");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "auto" })).toBe("auto");
    expect(tunnelProtocolArgs("http2")).toEqual(["--protocol", "http2"]);
  });

  it("rejects unknown protocols instead of silently falling back", () => {
    expect(() => resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "tcp" })).toThrow(
      /C2C_TUNNEL_PROTOCOL must be one of auto, quic, http2/
    );
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});
