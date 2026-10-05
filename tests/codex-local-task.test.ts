import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { CodexLocalTasks, LocalTaskError, type AppServerConnection } from "../src/execution/codex-local-task.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const dirs: string[] = [];
function workspace() { const root = makeTmpDir("local-task"); dirs.push(root); return new Workspace(root); }
afterEach(() => { dirs.splice(0).forEach(cleanup); });

class TestHost implements AppServerConnection {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  threads = new Map<string, Record<string, unknown>>();
  policy = { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite" } };
  gate?: Promise<void>;
  failedTurn = false;
  eventHandler = (_method: string, _params: Record<string, unknown>) => {};
  requestHandler = (_id: string | number, _method: string, _params: Record<string, unknown>) => {};
  decisions: unknown[] = [];
  async resolveApproval(id: string | number, decision: "accept" | "decline" | "cancel") { this.decisions.push({ id, decision }); }
  onNotification(handler: typeof this.eventHandler) { this.eventHandler = handler; }
  onServerRequest(handler: typeof this.requestHandler) { this.requestHandler = handler; }
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      await this.gate;
      const thread = { id: "thread-1", cwd: params.cwd, model: params.model, status: { type: "idle" }, turns: [] };
      this.threads.set("thread-1", thread);
      return { thread, model: params.model, cwd: params.cwd, ...this.policy };
    }
    const thread = this.threads.get(String(params.threadId));
    if (!thread) throw new Error("Thread not found");
    if (method === "thread/read") return { thread };
    if (method === "thread/resume") return { thread, model: params.model ?? thread.model, cwd: thread.cwd, ...this.policy };
    if (method === "turn/start") {
      if (this.failedTurn) throw new Error("Cannot start model");
      return { turn: { id: "turn-1", status: "inProgress", error: null, items: [] } };
    }
    if (method === "thread/turns/list") return { data: thread.turns, nextCursor: null };
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    throw new Error("unsupported method");
  }
  async close() {}
}

describe("Codex local task service", () => {
  it("passes jev-auto and inherits actual policies without overrides", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    const task = await tasks.create(ws, "client-a", { prompt: "Implement a test", model: "jev-auto", requestId: "create-1" });
    expect(task.threadId).toBe("thread-1");
    expect(task.model).toBe("jev-auto");
    expect(task.policy).toEqual(host.policy);
    expect(task.executionHost).toBe("codex-app-server");
    expect(task.desktopGuiVisible).toBeNull();
    expect(task.desktopHostId).toBeNull();
    expect(host.calls[0]).toEqual({ method: "thread/start", params: { cwd: ws.root, model: "jev-auto" } });
    expect(host.calls[1].params).toEqual({ threadId: "thread-1", model: "jev-auto", input: [{ type: "text", text: "Implement a test", text_elements: [] }] });
  });
  it("deduplicates concurrent create requests and rejects changed payloads", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    let release!: () => void; host.gate = new Promise<void>(resolve => { release = resolve; });
    const args = { prompt: "Do it", requestId: "same-key" };
    const first = tasks.create(ws, "client-a", args), second = tasks.create(ws, "client-a", args);
    await expect(tasks.create(ws, "client-a", { ...args, prompt: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    release();
    expect(await first).toEqual(await second);
    expect(host.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(host.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });
  it("rejects symlink escapes before contacting the host even when the leaf is missing", async () => {
    const ws = workspace(), outside = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    fs.symlinkSync(outside.root, path.join(ws.root, "escape"), "dir");
    for (const cwd of ["escape", "escape/not-created/yet", "../outside"]) {
      await expect(tasks.create(ws, "client-a", { prompt: "x", requestId: "path-test", cwd })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    }
    expect(host.calls).toHaveLength(0);
  });
  it("rejects read and resume of threads belonging to another workspace", async () => {
    const ws = workspace(), outside = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("foreign", { id: "foreign", cwd: outside.root, turns: [] });
    await expect(tasks.read(ws, "foreign")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(tasks.resume(ws, "client-a", { threadId: "foreign", prompt: "x", requestId: "resume-1" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    expect(host.calls.some(call => call.method === "thread/resume")).toBe(false);
  });
  it("reports known partial thread creation without retrying a failed first turn", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.failedTurn = true;
    const args = { prompt: "x", requestId: "failed-1" };
    const result = await tasks.create(ws, "client-a", args);
    expect(result.threadId).toBe("thread-1");
    expect(result.state).toBe("startFailed");
    expect(result.error).toContain("Cannot start model");
    expect(await tasks.create(ws, "client-a", args)).toEqual(result);
    expect(host.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
  });
  it("preserves approval requests for local review without any RPC accept", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    await tasks.create(ws, "client-a", { prompt: "x", requestId: "approval-task" });
    host.requestHandler(19, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1", command: "npm install", reason: "requires network" });
    const status = await tasks.status(ws, "thread-1");
    expect(status.state).toBe("waitingOnApproval");
    expect(status.pendingRequests).toEqual([expect.objectContaining({ requestId: "number:19", method: "item/commandExecution/requestApproval", command: "npm install" })]);
    expect(host.calls.some(call => call.method.includes("approval"))).toBe(false);
  });
  it("reads safe visible messages, excludes reasoning and secrets, and reports terminal errors", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("read-1", { id: "read-1", cwd: ws.root, status: { type: "idle" }, turns: [{ id: "turn-x", status: "failed", error: { message: "model unavailable" }, items: [
      { id: "a", type: "agentMessage", text: "answer password=private-value" },
      { id: "r", type: "reasoning", content: ["hidden thoughts"] },
      { id: "k", type: "agentMessage", text: "-----BEGIN PRIVATE KEY-----secret" },
    ] }] });
    const result = await tasks.read(ws, "read-1");
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(result)).not.toContain("hidden thoughts");
    expect(JSON.stringify(result)).not.toContain("BEGIN PRIVATE KEY");
    expect(result.messages).toContainEqual(expect.objectContaining({ text: "answer password=[REDACTED]" }));
  });
  it("resumes the same thread without overriding its cwd, approvals or sandbox", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("existing", { id: "existing", cwd: ws.root, model: "old-model", status: { type: "idle" }, turns: [] });
    const result = await tasks.resume(ws, "client-a", { threadId: "existing", prompt: "Continue", model: "jev-auto", requestId: "resume" });
    expect(result.threadId).toBe("existing");
    expect(host.calls.find(call => call.method === "thread/resume")?.params).toEqual({ threadId: "existing", model: "jev-auto" });
  });
  it("reports persisted terminal status even without an in-memory turn cache", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("finished", { id: "finished", cwd: ws.root, status: { type: "notLoaded" }, turns: [{ id: "last-turn", status: "completed", items: [] }] });
    const status = await tasks.status(ws, "finished");
    expect(status.state).toBe("completed"); expect(status.turnId).toBe("last-turn");
  });
  it("reads paginated items without requesting unsupported full-history hydration", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("pages", { id: "pages", cwd: ws.root, historyMode: "paginated", status: { type: "notLoaded" }, turns: [] });
    const original = host.request.bind(host);
    host.request = async (method, params) => {
      if (method === "thread/read" && params.includeTurns) throw new Error("Full history hydration is deprecated");
      if (method === "thread/items/list") { host.calls.push({ method, params }); return { data: [{ turnId: "p-turn", item: { id: "p-message", type: "agentMessage", text: "done" } }], nextCursor: "page-two" }; }
      if (method === "thread/turns/list") return { data: [{ id: "p-turn", status: "completed", items: [] }], nextCursor: null };
      return original(method, params);
    };
    const result = await tasks.read(ws, "pages", { cursor: "page-one", limit: 20 });
    expect(result.messages).toEqual([{ id: "p-message", role: "assistant", text: "done", truncated: false }]);
    expect(result.state).toBe("completed"); expect(result.nextCursor).toBe("page-two");
    expect(host.calls.find(call => call.method === "thread/items/list")?.params).toMatchObject({ cursor: "page-one", limit: 20 });
  });
  it("keeps accepted turn state when a response times out, and otherwise reports an unknown outcome", async () => {
    for (const notify of [true, false]) {
      const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
      const original = host.request.bind(host);
      host.request = async (method, params) => {
        if (method === "turn/start") {
          if (notify) host.eventHandler("turn/started", { threadId: "thread-1", turn: { id: "accepted-turn", status: "inProgress" } });
          throw new LocalTaskError("APP_SERVER_TIMEOUT", "response dropped");
        }
        return original(method, params);
      };
      const args = { prompt: "x", requestId: "uncertain" };
      const result = await tasks.create(ws, "client-a", args);
      expect(result.state).toBe(notify ? "inProgress" : "outcomeUnknown");
      expect(result.turnId).toBe(notify ? "accepted-turn" : null);
      expect(await tasks.create(ws, "client-a", args)).toEqual(result);
    }
  });
  it("does not misreport a previous completed turn as the outcome of a timed-out resume", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    await tasks.create(ws, "client-a", { prompt: "first", requestId: "first" });
    host.eventHandler("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    const original = host.request.bind(host);
    host.request = async (method, params) => { if (method === "turn/start") throw new LocalTaskError("APP_SERVER_TIMEOUT", "response dropped"); return original(method, params); };
    const result = await tasks.resume(ws, "client-a", { threadId: "thread-1", prompt: "second", requestId: "second" });
    expect(result.state).toBe("outcomeUnknown"); expect(result.turnId).toBeNull();
  });
  it("does not count a completion notification for the same old turn as acceptance of a resume", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    await tasks.create(ws, "client-a", { prompt: "first", requestId: "first" });
    const original = host.request.bind(host);
    host.request = async (method, params) => {
      if (method === "turn/start") { host.eventHandler("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }); throw new LocalTaskError("APP_SERVER_TIMEOUT", "response dropped"); }
      return original(method, params);
    };
    const result = await tasks.resume(ws, "client-a", { threadId: "thread-1", prompt: "second", requestId: "second" });
    expect(result.state).toBe("outcomeUnknown"); expect(result.turnId).toBeNull();
  });
  it("shows the actual file paths and diff from the item lifecycle before accepting a file request", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("files", { id: "files", cwd: ws.root, turns: [] });
    const fileChange = { type: "fileChange", id: "patch-item", changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "-old\n+new" }] };
    host.eventHandler("item/started", { threadId: "files", turnId: "file-turn", item: fileChange });
    host.requestHandler(88, "item/fileChange/requestApproval", { threadId: "files", turnId: "file-turn", itemId: "patch-item", reason: "extra write access", grantRoot: null });
    const review = await tasks.reviewLocalApproval(ws, "files", "number:88");
    expect(review.details.fileChange).toEqual(fileChange);
    await tasks.resolveLocalApproval(ws, "files", "number:88", review.reviewToken, "accept");
    expect(host.decisions).toEqual([{ id: 88, decision: "accept" }]);
  });
  it("refuses file acceptance when the diff is missing or changed after local review", async () => {
    const ws = workspace(), host = new TestHost(), tasks = new CodexLocalTasks(host);
    host.threads.set("files", { id: "files", cwd: ws.root, turns: [] });
    host.requestHandler(88, "item/fileChange/requestApproval", { threadId: "files", turnId: "file-turn", itemId: "patch-item" });
    const missing = await tasks.reviewLocalApproval(ws, "files", "number:88");
    await expect(tasks.resolveLocalApproval(ws, "files", "number:88", missing.reviewToken, "accept")).rejects.toMatchObject({ code: "FILE_REVIEW_UNAVAILABLE" });
    host.eventHandler("item/started", { threadId: "files", turnId: "file-turn", item: { type: "fileChange", id: "patch-item", changes: [{ path: "src/a.ts", diff: "old" }] } });
    const review = await tasks.reviewLocalApproval(ws, "files", "number:88");
    host.eventHandler("item/started", { threadId: "files", turnId: "file-turn", item: { type: "fileChange", id: "patch-item", changes: [{ path: "src/other.ts", diff: "different" }] } });
    await expect(tasks.resolveLocalApproval(ws, "files", "number:88", review.reviewToken, "accept")).rejects.toMatchObject({ code: "REVIEW_OPERATION_CHANGED" });
    expect(host.decisions).toEqual([]);
  });
});
