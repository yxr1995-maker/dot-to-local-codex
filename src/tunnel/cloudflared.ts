import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger, redact } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import { tunnelProtocolArgs } from "./protocol.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[^\s|]+/gi;
const QUICK_TUNNEL_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/i;
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_RECENT_OUTPUT_LINES = 80;
const MAX_RECENT_OUTPUT_BYTES = 32 * 1024;

type TransportOutput = { stream: "stdout" | "stderr"; message: string };

function safeTransportOutput(line: string): string {
  const safe = sanitizeExecutionOutput(line);
  return (safe.allowed ? safe.text : "[restricted output]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 2048);
}

type HealthProbeClassification = "dns" | "tls" | "timeout" | "network" | "transport";

interface SafeErrorDetails {
  errorName: string;
  causeName: string;
  errorCode?: string;
  message: string;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    chain.push(current);
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
    if (current === undefined) break;
  }
  return chain;
}

function errorProperty(error: unknown, key: "name" | "message" | "code"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function safeDiagnosticMessage(message: string): string {
  return redact(message)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 240);
}

function safeErrorDetails(error: unknown): SafeErrorDetails {
  const chain = errorChain(error);
  const top = chain[0];
  const deepest = chain[chain.length - 1];
  const errorName = errorProperty(top, "name") ?? "Error";
  const causeName = errorProperty(deepest, "name") ?? errorName;
  const rawErrorCode = [...chain].reverse().map((entry) => errorProperty(entry, "code"))
    .find((value) => value !== undefined && /^[A-Za-z0-9_.-]{1,80}$/.test(value));
  const errorCode = rawErrorCode ? safeDiagnosticMessage(rawErrorCode) : undefined;
  const message = [...chain].reverse().map((entry) => errorProperty(entry, "message"))
    .find((value) => value !== undefined) ?? String(error);
  return {
    errorName: safeDiagnosticMessage(errorName),
    causeName: safeDiagnosticMessage(causeName),
    ...(errorCode ? { errorCode } : {}),
    message: safeDiagnosticMessage(message),
  };
}

function classifyHealthProbeError(details: SafeErrorDetails): HealthProbeClassification {
  const code = details.errorCode?.toUpperCase() ?? "";
  const message = details.message.toLowerCase();
  if (/^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENODATA)$/.test(code) || /getaddrinfo|dns lookup/.test(message)) return "dns";
  if (/^(?:ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code) || /tls|certificate/.test(message)) return "tls";
  if (/TIMEOUT/.test(code) || /timed? ?out|timeout/.test(message) || details.causeName === "TimeoutError") return "timeout";
  if (/^(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET)$/.test(code) || /socket|connect/.test(message)) return "network";
  return "transport";
}

function isBridgeHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return health.service === SERVICE_NAME && health.status === "ok";
}

async function bridgeHealth(
  fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>,
  publicUrl: string
): Promise<{ ready: boolean; detail: string; failure?: { classification: "http" | "service_identity"; status: number } }> {
  const response = await fetchImpl(new URL("/health", publicUrl).toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!response) return { ready: false, detail: "Health check did not run" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ready: false,
      detail: `Public GET /health returned HTTP ${response.status}`,
      failure: { classification: "http", status: response.status },
    };
  }
  const payload = await response.json().catch(() => null);
  if (!isBridgeHealth(payload)) {
    return {
      ready: false,
      detail: `Public GET /health returned HTTP ${response.status} with unexpected service identity`,
      failure: { classification: "service_identity", status: response.status },
    };
  }
  return {
    ready: true,
    detail: `Public GET /health identified ${SERVICE_NAME}`,
  };
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  for (const match of line.matchAll(QUICK_TUNNEL_URL_RE)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST_RE.test(url.hostname)) continue;
      if (url.hostname.toLowerCase() === "api.trycloudflare.com") continue;
      return url.origin;
    } catch {
      // Ignore malformed URLs embedded in log output.
    }
  }
  return null;
}

export interface CloudflaredQuickTunnelOptions {
  startTimeoutMs?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredQuickTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;
  private starting: Promise<string> | null = null;
  private cancelStart: (() => void) | null = null;
  private readonly requestedStops = new WeakMap<ChildProcess, string>();

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    options: CloudflaredQuickTunnelOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? 45_000;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    if (this.starting) return this.starting;
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private startProcess(localPort: number): Promise<string> {
    const bin = this.binary();
    if (!bin) {
      this.logger.error("cloudflared executable unavailable", { stage: "cloudflared_acquisition", result: "not_found" });
      return Promise.reject(
        new Error(
          "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
        )
      );
    }

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        this.logger.info("Starting cloudflared process", { stage: "cloudflared_spawn", localPort });
        child = this.spawnImpl(
          bin,
          ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate", ...tunnelProtocolArgs()],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        );
      } catch (error) {
        this.logger.error("cloudflared process spawn failed", {
          stage: "cloudflared_spawn",
          ...safeErrorDetails(error),
        });
        reject(error);
        return;
      }
      this.child = child;
      this.url = null;
      this.lastError = null;
      child.once("spawn", () => {
        this.logger.info("cloudflared process started", { stage: "cloudflared_process_spawn", pid: child.pid ?? null, localPort });
      });
      let settled = false;
      let candidateUrl: string | null = null;
      let lastProbe: { classification: string; code?: string; detail: string } | null = null;
      let lastLoggedProbe = "";
      let cancel: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const readers: readline.Interface[] = [];
      const recentOutput: TransportOutput[] = [];
      const retainOutput = (stream: TransportOutput["stream"], line: string): string => {
        const message = safeTransportOutput(line);
        recentOutput.push({ stream, message });
        while (recentOutput.length > MAX_RECENT_OUTPUT_LINES || Buffer.byteLength(JSON.stringify(recentOutput)) > MAX_RECENT_OUTPUT_BYTES) recentOutput.shift();
        return message;
      };

      const closeReaders = (): void => {
        for (const reader of readers) reader.close();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const isAlive = (): boolean => this.child === child;

      const stopChild = (reason: string): void => {
        this.requestedStops.set(child, reason);
        this.logger.info("cloudflared stop requested", { stage: "cloudflared_stop_requested", pid: child.pid ?? null, reason });
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill().
        }
      };

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        callback();
      };

      const fail = (error: unknown, stopReason?: string): void => {
        finish(() => {
          if (stopReason) stopChild(stopReason);
          if (this.child === child) {
            this.child = null;
            this.url = null;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      cancel = () => fail(new Error("Tunnel start stopped"), "explicit_stop");
      this.cancelStart = cancel;

      const ready = (url: string): void => {
        if (!isAlive()) {
          fail(new Error("cloudflared exited before the public health endpoint became ready"));
          return;
        }
        finish(
          () => {
            this.url = url;
            this.lastError = null;
            this.logger.info("Quick tunnel established", { hostname: new URL(url).hostname });
            resolve(url);
          }
        );
      };

      const waitForHealth = async (): Promise<void> => {
        const publicUrl = candidateUrl;
        if (!publicUrl) return;
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("cloudflared exited before the public health endpoint became ready"));
            return;
          }

          try {
            const result = await bridgeHealth(this.fetchImpl, publicUrl);
            if (settled) return;
            if (result.ready) {
              ready(publicUrl);
              return;
            }
            this.lastError = result.detail;
            const classification = result.failure?.classification ?? "service_identity";
            const code = result.failure?.status === undefined ? undefined : `HTTP_${result.failure.status}`;
            const signature = `${classification}:${code ?? ""}:${result.detail}`;
            lastProbe = { classification, ...(code ? { code } : {}), detail: result.detail };
            if (signature !== lastLoggedProbe) {
              lastLoggedProbe = signature;
              this.logger.warn("Quick tunnel public health probe returned a non-ready response", {
                stage: "public_health_get",
                method: "GET",
                path: "/health",
                hostname: new URL(publicUrl).hostname,
                classification,
                ...(result.failure?.status === undefined ? {} : { status: result.failure.status }),
              });
            }
          } catch (error) {
            if (settled) return;
            const details = safeErrorDetails(error);
            const classification = classifyHealthProbeError(details);
            const code = details.errorCode;
            const detail = `Public GET /health ${classification}${code ? ` (${code})` : ""}: ${details.message}`;
            this.lastError = detail;
            const signature = `${classification}:${code ?? ""}:${details.message}`;
            lastProbe = { classification, ...(code ? { code } : {}), detail };
            if (signature !== lastLoggedProbe) {
              lastLoggedProbe = signature;
              this.logger.warn("Quick tunnel public health probe failed", {
                stage: "public_health_get",
                method: "GET",
                path: "/health",
                hostname: new URL(publicUrl).hostname,
                classification,
                errorName: details.errorName,
                causeName: details.causeName,
                ...(code ? { errorCode: code } : {}),
                errorMessage: details.message,
              });
            }
          }
          if (settled) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_CHECK_INTERVAL_MS));
        }
      };

      timeout = setTimeout(() => {
        if (!settled) {
          const hostname = candidateUrl ? new URL(candidateUrl).hostname : null;
          this.logger.error("Quick tunnel startup timeout", {
            stage: "startup_timeout",
            timeoutMs: this.startTimeoutMs,
            hostname,
            lastProbeClassification: lastProbe?.classification ?? null,
            lastProbeCode: lastProbe?.code ?? null,
            lastProbeDetail: lastProbe?.detail ?? "No public health response before timeout",
            recentOutput: [...recentOutput],
          });
          fail(new Error(`Tunnel start timed out after ${this.startTimeoutMs}ms${lastProbe ? `; ${lastProbe.detail}` : "; no public health response"}`), "startup_timeout");
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream, source: TransportOutput["stream"]): void => {
        const rl = readline.createInterface({ input: stream });
        readers.push(rl);
        rl.on("line", (line) => {
          const safeLine = retainOutput(source, line);
          this.logger.debug("cloudflared diagnostic output", { stage: "cloudflared_process_output", stream: source, message: safeLine });
          const url = parseQuickTunnelUrl(line);
          if (url && !candidateUrl) {
            candidateUrl = url;
            this.logger.info("Quick tunnel hostname announced", {
              stage: "cloudflared_acquisition",
              hostname: new URL(url).hostname,
            });
            void waitForHealth().catch((error) => {
              const details = safeErrorDetails(error);
              this.logger.error("Quick tunnel public health check aborted", {
                stage: "public_health_get",
                hostname: new URL(url).hostname,
                errorName: details.errorName,
                ...(details.errorCode ? { errorCode: details.errorCode } : {}),
                errorMessage: details.message,
              });
            });
          }
          if (isAlive() && !this.requestedStops.has(child) && /\b(?:ERR|error|failed|fatal)\b/i.test(line)) {
            this.lastError = safeLine;
          }
        });
      };
      if (child.stdout) scan(child.stdout, "stdout");
      if (child.stderr) scan(child.stderr, "stderr");

      child.on("error", (error) => {
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        this.logger.error("cloudflared process error", {
          stage: "cloudflared_process",
          ...safeErrorDetails(error),
        });
        if (!settled) fail(error, "process_error");
      });
      child.on("exit", (code, signal) => {
        const stopRequestedReason = this.requestedStops.get(child) ?? null;
        if (this.child === child) {
          this.child = null;
          this.url = null;
          if (!stopRequestedReason || !this.lastError) this.lastError = `cloudflared exited (code ${code}, signal ${signal ?? child.signalCode ?? "none"})`;
        }
        this.logger.warn("cloudflared process exited", { stage: "cloudflared_process_exit", pid: child.pid ?? null, code, signal: signal ?? child.signalCode ?? null, stopRequestedReason });
        if (!settled) {
          fail(
            new Error(
              `cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
            )
          );
        }
      });
      // `exit` precedes stdio completion. Keep draining until `close` so a
      // timeout-induced SIGTERM cannot turn our closed pipes into SIGPIPE.
      child.on("close", (code, signal) => {
        this.logger.warn("cloudflared process closed", {
          stage: "cloudflared_process_close", pid: child.pid ?? null, code,
          signal: signal ?? child.signalCode ?? null,
          stopRequestedReason: this.requestedStops.get(child) ?? null,
          recentOutput: [...recentOutput],
        });
        closeReaders();
        this.requestedStops.delete(child);
      });
    });
  }

  async stop(): Promise<void> {
    this.cancelStart?.();
    if (this.child) {
      this.requestedStops.set(this.child, "explicit_stop");
      this.logger.info("cloudflared stop requested", { stage: "cloudflared_stop_requested", pid: this.child.pid ?? null, reason: "explicit_stop" });
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The process may have exited between the state check and kill().
      }
      this.child = null;
    }
    this.url = null;
    this.lastError = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
