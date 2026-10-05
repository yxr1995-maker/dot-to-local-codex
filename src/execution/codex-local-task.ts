import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { sanitizeExecutionOutput } from "./sanitize.js";

export interface AppServerConnection {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  onServerRequest(handler: (id: string | number, method: string, params: Record<string, unknown>) => void): void;
  close(): Promise<void>;
  /** Trusted local admin only; not exposed as an MCP tool. */
  resolveApproval?(id: string | number, decision: "accept" | "decline" | "cancel"): Promise<void>;
}
export interface CreateTaskInput { prompt: string; requestId: string; model?: string; cwd?: string; }
export interface ResumeTaskInput { prompt: string; requestId: string; model?: string; threadId: string; }
export interface TaskMessage { id: string; role: "user" | "assistant"; text: string; truncated: boolean; }
export interface PendingLocalRequest {
  requestId: string; method: string; threadId: string; turnId: string | null;
  command?: string; reason?: string; cwd?: string;
  resolution: "local-review-required";
}
export interface LocalTaskResult {
  workspaceId: string; threadId: string; turnId: string | null;
  executionHost: "codex-app-server"; desktopHostId: null; desktopGuiVisible: null;
  state: string; model: string | null; policy: Record<string, unknown> | null;
  pendingRequests: PendingLocalRequest[]; error: string | null;
  messages?: TaskMessage[]; nextCursor?: string | null; historyMode?: string;
}
export class LocalTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalTaskError"; }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  const sanitized = sanitizeExecutionOutput(value);
  return sanitized.allowed ? sanitized.text : "[restricted output]";
}
function validateInput(input: CreateTaskInput | ResumeTaskInput): void {
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) {
    throw new LocalTaskError("INVALID_REQUEST_ID", "requestId must be 1–128 letters, numbers or . _ : -.");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 64 * 1024) {
    throw new LocalTaskError("INVALID_PROMPT", "A nonempty prompt of at most 64 KiB is required.");
  }
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || input.model.includes("\0"))) {
    throw new LocalTaskError("INVALID_MODEL", "Invalid model name.");
  }
}

/** Keeps execution policy with Codex; MCP never supplies or resolves approvals. */
export class CodexLocalTasks {
  private operations = new Map<string, { fingerprint: string; result: Promise<LocalTaskResult> }>();
  private policies = new Map<string, Record<string, unknown>>();
  private pending = new Map<string, PendingLocalRequest>();
  private pendingRpcIds = new Map<string, string | number>();
  private pendingDetails = new Map<string, Record<string, unknown>>();
  private reviewTickets = new Map<string, { workspaceId: string; threadId: string; requestId: string; pending: PendingLocalRequest; operationHash: string; expiresAt: number }>();
  private fileChanges = new Map<string, Record<string, unknown>>();
  private turns = new Map<string, Record<string, unknown>>();
  constructor(private host: AppServerConnection) {
    host.onServerRequest((id, method, params) => {
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      if (!threadId) return;
      const key = `${typeof id}:${id}`;
      this.pendingRpcIds.set(key, id);
      this.pendingDetails.set(key, params);
      this.pending.set(key, {
        requestId: key, method, threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        ...(typeof params.command === "string" ? { command: safeText(params.command) } : {}),
        ...(typeof params.reason === "string" ? { reason: safeText(params.reason) } : {}),
        ...(typeof params.cwd === "string" ? { cwd: safeText(params.cwd) } : {}),
        resolution: "local-review-required",
      });
    });
    host.onNotification((method, params) => {
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      if (method === "connection/closed") { this.pending.clear(); this.pendingRpcIds.clear(); this.pendingDetails.clear(); this.reviewTickets.clear(); this.fileChanges.clear(); }
      if ((method === "item/started" || method === "item/completed") && threadId) {
        const item = record(params.item);
        if (item.type === "fileChange" && typeof item.id === "string") {
          const key = JSON.stringify([threadId, params.turnId, item.id]);
          // Retain complete bounded patches for local review; oversized/unavailable
          // operations cannot be accepted rather than being shown as truncated.
          if (Buffer.byteLength(JSON.stringify(item)) <= 1024 * 1024) {
            if (this.fileChanges.size >= 100) this.fileChanges.delete(this.fileChanges.keys().next().value!);
            this.fileChanges.set(key, item);
          } else this.fileChanges.delete(key);
        }
      }
      if (method === "serverRequest/resolved") {
        const key = `${typeof params.requestId}:${params.requestId}`;
        this.pending.delete(key); this.pendingRpcIds.delete(key); this.pendingDetails.delete(key);
      }
      if ((method === "turn/completed" || method === "turn/started") && threadId) {
        this.turns.set(threadId, record(params.turn));
        if (method === "turn/completed") {
          for (const [id, pending] of this.pending) if (pending.threadId === threadId) { this.pending.delete(id); this.pendingRpcIds.delete(id); this.pendingDetails.delete(id); }
        }
      }
    });
  }
  private once(ws: Workspace, client: string, operation: string, input: CreateTaskInput | ResumeTaskInput, run: () => Promise<LocalTaskResult>): Promise<LocalTaskResult> {
    validateInput(input);
    const key = JSON.stringify([ws.id, client, operation, input.requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.operations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new LocalTaskError("IDEMPOTENCY_CONFLICT", "This requestId was already used with different arguments.");
      return previous.result;
    }
    // Never evict in-flight or failed requests: an RPC timeout may have changed state.
    if (this.operations.size >= 10_000) throw new LocalTaskError("OPERATION_LIMIT", "The bridge's operation limit has been reached.");
    const result = Promise.resolve().then(run);
    this.operations.set(key, { fingerprint, result });
    return result;
  }
  private cwd(ws: Workspace, requested = "."): string {
    const { abs } = ws.resolve(requested);
    try { if (fs.statSync(abs).isDirectory()) return abs; } catch { /* report a stable error below */ }
    throw new LocalTaskError("INVALID_CWD", "The task cwd must be an existing directory inside the selected workspace.");
  }
  private async ownedThread(ws: Workspace, threadId: string, includeTurns = false): Promise<Record<string, unknown>> {
    if (!threadId || threadId.length > 200 || threadId.includes("\0")) throw new LocalTaskError("INVALID_THREAD_ID", "Invalid threadId.");
    const response = await this.host.request("thread/read", { threadId, includeTurns });
    const thread = record(response.thread);
    if (thread.id !== threadId || typeof thread.cwd !== "string") throw new LocalTaskError("INVALID_HOST_RESPONSE", "The host did not return this thread's identity and cwd.");
    this.cwd(ws, thread.cwd);
    return thread;
  }
  private rememberPolicy(threadId: string, response: Record<string, unknown>): void {
    // Preserve what the host actually reports. Do not infer defaults or provenance.
    const policy: Record<string, unknown> = {};
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "activePermissionProfile"]) {
      if (response[key] !== undefined) policy[key] = response[key];
    }
    if (Object.keys(policy).length) this.policies.set(threadId, policy);
  }
  private summary(ws: Workspace, thread: Record<string, unknown>, turn?: Record<string, unknown>): LocalTaskResult {
    const threadId = String(thread.id);
    const pendingRequests = [...this.pending.values()].filter(item => item.threadId === threadId);
    const status = record(thread.status);
    const latest = turn ?? this.turns.get(threadId);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    let state = typeof latest?.status === "string" ? latest.status : typeof status.type === "string" ? status.type : "unknown";
    if (pendingRequests.some(item => item.method.endsWith("requestApproval")) || flags.includes("waitingOnApproval")) state = "waitingOnApproval";
    else if (pendingRequests.length || flags.includes("waitingOnUserInput")) state = "waitingOnUserInput";
    return {
      workspaceId: ws.id, threadId, turnId: typeof latest?.id === "string" ? latest.id : null,
      executionHost: "codex-app-server", desktopHostId: null, desktopGuiVisible: null,
      state, model: typeof thread.model === "string" ? thread.model : null,
      policy: this.policies.get(threadId) ?? null, pendingRequests,
      error: typeof record(latest?.error).message === "string" ? safeText(record(latest?.error).message) : null,
    };
  }
  private async startTurn(ws: Workspace, thread: Record<string, unknown>, input: CreateTaskInput | ResumeTaskInput): Promise<LocalTaskResult> {
    const previousTurn = this.turns.get(String(thread.id)) ?? (Array.isArray(thread.turns) ? record(thread.turns.at(-1)) : undefined);
    try {
      const response = await this.host.request("turn/start", {
        threadId: thread.id,
        ...(input.model ? { model: input.model } : {}),
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
      });
      const turn = record(response.turn);
      if (typeof turn.id !== "string") throw new LocalTaskError("INVALID_HOST_RESPONSE", "The host did not return a turn id.");
      this.turns.set(String(thread.id), turn);
      return this.summary(ws, thread, turn);
    } catch (error) {
      const summary = this.summary(ws, thread);
      const uncertain = error instanceof LocalTaskError && ["APP_SERVER_TIMEOUT", "APP_SERVER_DISCONNECTED", "APP_SERVER_PROTOCOL_ERROR"].includes(error.code);
      const observed = this.turns.get(String(thread.id));
      const observedThisAttempt = typeof observed?.id === "string" && observed.id !== previousTurn?.id;
      return { ...summary, state: uncertain ? (observedThisAttempt ? summary.state : "outcomeUnknown") : "startFailed", turnId: uncertain && !observedThisAttempt ? null : summary.turnId, error: safeText(error instanceof Error ? error.message : "Turn start failed") };
    }
  }
  async create(ws: Workspace, client: string, input: CreateTaskInput): Promise<LocalTaskResult> {
    // Validate and resolve before reserving; no host call can happen on path failure.
    validateInput(input);
    const cwd = this.cwd(ws, input.cwd);
    return this.once(ws, client, "create", input, async () => {
      const response = await this.host.request("thread/start", { cwd, ...(input.model ? { model: input.model } : {}) });
      const thread = record(response.thread);
      if (typeof thread.id !== "string" || typeof thread.cwd !== "string") throw new LocalTaskError("INVALID_HOST_RESPONSE", "The host did not return the new thread identity and cwd.");
      this.cwd(ws, thread.cwd);
      if (typeof response.model === "string") thread.model = response.model;
      this.rememberPolicy(thread.id, response);
      return this.startTurn(ws, thread, input);
    });
  }
  async resume(ws: Workspace, client: string, input: ResumeTaskInput): Promise<LocalTaskResult> {
    return this.once(ws, client, "resume", input, async () => {
      await this.ownedThread(ws, input.threadId);
      const response = await this.host.request("thread/resume", { threadId: input.threadId, ...(input.model ? { model: input.model } : {}) });
      const thread = record(response.thread);
      if (thread.id !== input.threadId || typeof thread.cwd !== "string") throw new LocalTaskError("INVALID_HOST_RESPONSE", "The host resumed a different thread or omitted cwd.");
      this.cwd(ws, thread.cwd);
      if (typeof response.model === "string") thread.model = response.model;
      this.rememberPolicy(input.threadId, response);
      return this.startTurn(ws, thread, input);
    });
  }
  async status(ws: Workspace, threadId: string): Promise<LocalTaskResult> {
    const thread = await this.ownedThread(ws, threadId, false);
    if (thread.historyMode === "paginated") {
      const page = await this.host.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" });
      const latest = Array.isArray(page.data) ? record(page.data[0]) : undefined;
      return this.summary(ws, thread, latest);
    }
    const hydrated = await this.ownedThread(ws, threadId, true);
    const latest = Array.isArray(hydrated.turns) && hydrated.turns.length ? record(hydrated.turns.at(-1)) : undefined;
    return this.summary(ws, thread, latest);
  }
  async read(ws: Workspace, threadId: string, opts: { cursor?: string; limit?: number } = {}): Promise<LocalTaskResult> {
    let thread = await this.ownedThread(ws, threadId, false);
    if (thread.historyMode !== "paginated") thread = await this.ownedThread(ws, threadId, true);
    let turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
    let messages: TaskMessage[] = [], nextCursor: string | null = null;
    if (thread.historyMode === "paginated") {
      const page = await this.host.request("thread/items/list", { threadId, ...(opts.cursor ? { cursor: opts.cursor } : {}), limit: Math.min(100, Math.max(1, opts.limit ?? 50)), sortDirection: "desc" });
      messages = this.messages(Array.isArray(page.data) ? page.data.map(entry => record(record(entry).item)) : []);
      nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      const latest = await this.host.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" });
      turns = Array.isArray(latest.data) ? latest.data.map(record) : [];
    } else {
      messages = this.messages(turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.map(record) : [])).slice(-100);
    }
    const latest = thread.historyMode === "paginated" ? turns[0] : turns.at(-1);
    return { ...this.summary(ws, thread, latest), messages, nextCursor, historyMode: typeof thread.historyMode === "string" ? thread.historyMode : "legacy" };
  }
  private messages(items: Record<string, unknown>[]): TaskMessage[] {
    const output: TaskMessage[] = [];
    for (const item of items) {
      let raw: string | undefined, role: TaskMessage["role"];
      if (item.type === "agentMessage" && typeof item.text === "string") { raw = item.text; role = "assistant"; }
      else if (item.type === "userMessage" && Array.isArray(item.content)) {
        raw = item.content.map(record).filter(input => input.type === "text" && typeof input.text === "string").map(input => input.text).join("\n"); role = "user";
      } else continue;
      const safe = sanitizeExecutionOutput(raw);
      output.push({ id: typeof item.id === "string" ? item.id : "", role, text: safe.allowed ? safe.text : "[restricted output]", truncated: safe.allowed ? safe.truncated : false });
    }
    return output;
  }
  async close(): Promise<void> { await this.host.close(); }
  async reviewLocalApproval(ws: Workspace, threadId: string, requestId: string): Promise<{ reviewToken: string; requestId: string; expiresAt: number; method: string; details: Record<string, unknown> }> {
    await this.ownedThread(ws, threadId);
    const pending = this.pending.get(requestId), details = this.pendingDetails.get(requestId);
    if (!pending || pending.threadId !== threadId || !details) throw new LocalTaskError("APPROVAL_NOT_PENDING", "This approval request is no longer pending for this thread.");
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(pending.method)) throw new LocalTaskError("LOCAL_INPUT_UNSUPPORTED", "This request requires an input or secure flow that this approval CLI does not support.");
    const now = Date.now();
    for (const [token, ticket] of this.reviewTickets) if (ticket.expiresAt <= now || this.pending.get(ticket.requestId) !== ticket.pending) this.reviewTickets.delete(token);
    const reviewToken = randomBytes(32).toString("base64url"), expiresAt = now + 5 * 60_000;
    const operation = this.localOperation(pending, details);
    this.reviewTickets.set(reviewToken, { workspaceId: ws.id, threadId, requestId, pending, operationHash: createHash("sha256").update(JSON.stringify(operation)).digest("hex"), expiresAt });
    return { reviewToken, requestId, expiresAt, method: pending.method, details: operation };
  }
  private localOperation(pending: PendingLocalRequest, details: Record<string, unknown>): Record<string, unknown> {
    if (pending.method !== "item/fileChange/requestApproval") return details;
    const fileChange = this.fileChanges.get(JSON.stringify([pending.threadId, pending.turnId, details.itemId]));
    return { ...details, fileChange: fileChange ?? null };
  }
  async resolveLocalApproval(ws: Workspace, threadId: string, requestId: string, reviewToken: string, decision: "accept" | "decline" | "cancel"): Promise<void> {
    if (!["accept", "decline", "cancel"].includes(decision)) throw new LocalTaskError("INVALID_APPROVAL_DECISION", "Only a single-request accept, decline or cancel is allowed.");
    await this.ownedThread(ws, threadId);
    const pending = this.pending.get(requestId), rpcId = this.pendingRpcIds.get(requestId);
    if (!pending || pending.threadId !== threadId || rpcId === undefined) throw new LocalTaskError("APPROVAL_NOT_PENDING", "This approval request is no longer pending for this thread.");
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(pending.method)) throw new LocalTaskError("LOCAL_INPUT_UNSUPPORTED", "This request requires an input or secure flow that this approval CLI does not support.");
    const ticket = this.reviewTickets.get(reviewToken);
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.workspaceId !== ws.id || ticket.threadId !== threadId || ticket.requestId !== requestId || ticket.pending !== pending) throw new LocalTaskError("INVALID_REVIEW_TOKEN", "Local review expired or does not match this pending request. Inspect the request again.");
    const details = this.pendingDetails.get(requestId) ?? {};
    const operation = this.localOperation(pending, details);
    if (pending.method === "item/fileChange/requestApproval" && decision === "accept") {
      const changes = record(operation.fileChange).changes;
      if (!Array.isArray(changes) || !changes.length || changes.some(change => typeof record(change).path !== "string" || typeof record(change).diff !== "string")) throw new LocalTaskError("FILE_REVIEW_UNAVAILABLE", "The complete file paths and diff are unavailable. This file request cannot be accepted through the CLI.");
    }
    if (ticket.operationHash !== createHash("sha256").update(JSON.stringify(operation)).digest("hex")) throw new LocalTaskError("REVIEW_OPERATION_CHANGED", "The operation changed after local review. Inspect it again before deciding.");
    if (decision === "accept" && (details.grantRoot || (Array.isArray(details.availableDecisions) && !details.availableDecisions.includes("accept")))) throw new LocalTaskError("NON_SINGLE_USE_APPROVAL", "The host did not offer a one-shot accept decision for this request.");
    if (!this.host.resolveApproval) throw new LocalTaskError("LOCAL_REVIEW_UNAVAILABLE", "This host does not support local approval responses.");
    // Consume all reviews and reserve this callback before any asynchronous write.
    for (const [token, review] of this.reviewTickets) if (review.requestId === requestId) this.reviewTickets.delete(token);
    this.pending.delete(requestId); this.pendingRpcIds.delete(requestId); this.pendingDetails.delete(requestId);
    await this.host.resolveApproval(rpcId, decision);
  }
}
