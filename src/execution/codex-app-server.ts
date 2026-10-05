import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LocalTaskError, type AppServerConnection } from "./codex-local-task.js";
import { VERSION } from "../version.js";

export interface CodexAppServerOptions {
  /** Trusted local deployment configuration, never an MCP argument. */
  command?: string; args?: string[]; cwd: string; env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
type Handler = (method: string, params: Record<string, unknown>) => void;
type RequestHandler = (id: string | number, method: string, params: Record<string, unknown>) => void;
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** A private child stdio transport. No listening socket and no shell execution. */
export class CodexAppServer implements AppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private approvals = new Map<string, { id: string | number; method: string; threadId: unknown }>();
  private notifications: Handler = () => {};
  private serverRequests: RequestHandler = () => {};
  private buffer = "";
  private closed = false;
  private failure: Error | null = null;
  constructor(private options: CodexAppServerOptions) {}
  onNotification(handler: Handler): void { this.notifications = handler; }
  onServerRequest(handler: RequestHandler): void { this.serverRequests = handler; }
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.closed) return Promise.reject(new LocalTaskError("APP_SERVER_DISCONNECTED", "The app-server connection is closed."));
    this.child = spawn(this.options.command ?? "codex", this.options.args ?? ["app-server", "--stdio"], {
      cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data: string) => this.consume(data));
    // Drain stderr without returning raw diagnostic/credential data over MCP.
    this.child.stderr.resume();
    this.child.on("error", () => this.disconnect(new LocalTaskError("APP_SERVER_UNAVAILABLE", "Could not launch the configured local Codex app-server.")));
    this.child.on("close", () => this.disconnect(new LocalTaskError("APP_SERVER_DISCONNECTED", "The local Codex app-server disconnected. The outcome of outstanding operations may be unknown.")));
    this.child.stdin.on("error", () => this.disconnect(new LocalTaskError("APP_SERVER_DISCONNECTED", "The app-server input stream closed.")));
    this.ready = this.send("initialize", {
      clientInfo: { name: "c2c-local-task-bridge", title: "Codex with ChatGPT local tasks", version: VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true },
    }).then(() => this.write({ method: "initialized" }));
    return this.ready;
  }
  private disconnect(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.approvals.clear();
    this.notifications("connection/closed", {});
  }
  private write(message: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.child.stdin.destroyed) throw new LocalTaskError("APP_SERVER_DISCONNECTED", "The app-server connection is unavailable.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LocalTaskError("APP_SERVER_TIMEOUT", `The '${method}' request timed out. Do not repeat a mutation with a new requestId before checking its outcome.`));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private consume(data: string): void {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.disconnect(new LocalTaskError("APP_SERVER_PROTOCOL_ERROR", "App-server message exceeded the transport limit."));
      this.child?.kill(); return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n"); if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { this.disconnect(new LocalTaskError("APP_SERVER_PROTOCOL_ERROR", "The app-server emitted invalid JSON.")); this.child?.kill(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
      if (typeof message.method === "string") {
        if (typeof message.id === "number" || typeof message.id === "string") {
          // Hold callbacks for a local reviewer. No automatic accept, fallback decision,
          // session-wide approval, policy amendment or sensitive-data submission.
          if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
            this.approvals.set(JSON.stringify(message.id), { id: message.id, method: message.method, threadId: params.threadId });
          }
          this.serverRequests(message.id, message.method, params);
        } else {
          if (message.method === "serverRequest/resolved") this.approvals.delete(JSON.stringify(params.requestId));
          if (message.method === "turn/completed") for (const [key, approval] of this.approvals) if (approval.threadId === params.threadId) this.approvals.delete(key);
          this.notifications(message.method, params);
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          const error = message.error as { code?: number; message?: string };
          pending.reject(new LocalTaskError("APP_SERVER_RPC_ERROR", `App-server RPC ${error.code ?? "error"}: ${error.message ?? "request failed"}`));
        } else if (message.result && typeof message.result === "object" && !Array.isArray(message.result)) pending.resolve(message.result as Record<string, unknown>);
        else pending.reject(new LocalTaskError("APP_SERVER_PROTOCOL_ERROR", "The app-server returned a non-object RPC result."));
      }
    }
  }
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.start();
    return this.send(method, params);
  }
  async resolveApproval(id: string | number, decision: "accept" | "decline" | "cancel"): Promise<void> {
    if (!["accept", "decline", "cancel"].includes(decision)) throw new LocalTaskError("INVALID_APPROVAL_DECISION", "Only a one-shot approval decision is allowed.");
    const key = JSON.stringify(id);
    if (!this.approvals.has(key)) throw new LocalTaskError("APPROVAL_NOT_PENDING", "This app-server approval is no longer pending.");
    this.approvals.delete(key);
    this.write({ id, result: { decision } });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.disconnect(new LocalTaskError("APP_SERVER_DISCONNECTED", "The app-server connection closed."));
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 1000);
      child.once("close", done);
      child.stdin.end(); child.kill("SIGTERM");
    });
  }
}
