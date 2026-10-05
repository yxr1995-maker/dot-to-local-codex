import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import { request } from "node:http";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { CodexLocalTasks, type AppServerConnection } from "../src/execution/codex-local-task.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const bridges: Bridge[] = [], dirs: string[] = [];
function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json(): Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "GET", headers: opts.headers }, res => {
      let data = ""; res.setEncoding("utf8"); res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(data) }));
    });
    req.on("error", reject); req.end(opts.body);
  });
}
afterEach(async () => { vi.restoreAllMocks(); for (const bridge of bridges.splice(0)) await bridge.close(); dirs.splice(0).forEach(cleanup); });
async function setup(enableLocalReview = true) {
  const root = makeTmpDir("local-review"); dirs.push(root);
  let notify = (_id: string | number, _method: string, _params: Record<string, unknown>) => {};
  const decisions: unknown[] = [];
  const host: AppServerConnection = {
    async request(_method, params) { return { thread: { id: params.threadId, cwd: root, status: { type: "active" }, turns: [] } }; },
    onNotification() {}, onServerRequest(handler) { notify = handler; },
    async resolveApproval(id, decision) { decisions.push({ id, decision }); }, async close() {},
  };
  const tasks = new CodexLocalTasks(host);
  const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: path.join(root, "auth.json"), localTasks: tasks, enableLocalReview }); bridges.push(bridge);
  notify(77, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1", command: "npm install --registry=https://registry.npmjs.org", cwd: root, availableDecisions: ["accept", "decline", "cancel"] });
  const headers = { Authorization: `Bearer ${bridge.adminToken}`, "x-c2c-local-review": "1" };
  const query = new URLSearchParams({ workspaceId: bridge.workspace.id, threadId: "thread-1", requestId: "number:77" });
  return { bridge, headers, query, decisions, notify };
}
describe("local human review admin boundary", () => {
  it("keeps both approval routes disabled by default even for the local admin", async () => {
    const { bridge, headers, query, decisions } = await setup(false);
    expect((await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).status).toBe(404);
    expect((await send(`${bridge.localBaseUrl()}/admin/local-tasks/decision`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ decision: "accept" }) })).status).toBe(404);
    expect(decisions).toEqual([]);
  });
  it("returns full current operation only to authenticated non-browser loopback review", async () => {
    const { bridge, headers, query, decisions } = await setup();
    const response = await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers });
    expect(response.status).toBe(200);
    const review = await response.json() as { reviewToken: string; details: { command: string } };
    expect(review.reviewToken.length).toBeGreaterThan(30); expect(review.details.command).toBe("npm install --registry=https://registry.npmjs.org"); expect(decisions).toEqual([]);
  });
  it("rejects bad auth, browser Origin, unexpected Host and proxy headers", async () => {
    const { bridge, headers, query, decisions } = await setup();
    const variants = [
      { ...headers, Authorization: "Bearer wrong" }, { ...headers, Origin: "https://attacker.example" },
      { ...headers, Host: "attacker.example" }, { ...headers, "X-Forwarded-For": "127.0.0.1" },
      { ...headers, Forwarded: "for=127.0.0.1" }, { ...headers, "sec-fetch-site": "cross-site" },
      { Authorization: headers.Authorization },
    ];
    for (const variant of variants) expect((await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers: variant })).status).toBe(404);
    expect(decisions).toEqual([]);
  });
  it("binds a short-lived review token to one request and prevents concurrent replays", async () => {
    const { bridge, headers, query, decisions } = await setup();
    const review = await (await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).json() as { reviewToken: string };
    const body = { workspaceId: bridge.workspace.id, threadId: "thread-1", requestId: "number:77", reviewToken: review.reviewToken, decision: "accept" };
    const submit = (changes = {}) => send(`${bridge.localBaseUrl()}/admin/local-tasks/decision`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...body, ...changes }) });
    expect((await submit({ reviewToken: "forged" })).status).toBe(400);
    expect((await submit({ decision: "acceptForSession" })).status).toBe(400);
    const responses = await Promise.all([submit(), submit()]); expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    expect(decisions).toEqual([{ id: 77, decision: "accept" }]);
    expect((await submit()).status).toBe(400);
  });
  it("invalidates a review when the original callback is replaced or resolved", async () => {
    const { bridge, headers, query, notify, decisions } = await setup();
    const review = await (await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).json() as { reviewToken: string };
    notify(77, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-2", command: "different command" });
    const response = await send(`${bridge.localBaseUrl()}/admin/local-tasks/decision`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: bridge.workspace.id, threadId: "thread-1", requestId: "number:77", reviewToken: review.reviewToken, decision: "accept" }) });
    expect(response.status).toBe(400); expect(decisions).toEqual([]);
  });
  it("rejects expired reviews and reviews for another thread or workspace", async () => {
    const { bridge, headers, query, decisions } = await setup();
    const review = await (await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).json() as { reviewToken: string; expiresAt: number };
    const body = { workspaceId: bridge.workspace.id, threadId: "thread-1", requestId: "number:77", reviewToken: review.reviewToken, decision: "accept" };
    const submit = (changes = {}) => send(`${bridge.localBaseUrl()}/admin/local-tasks/decision`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...body, ...changes }) });
    expect((await submit({ threadId: "other-thread" })).status).toBe(400);
    expect((await submit({ workspaceId: "unknown" })).status).toBe(400);
    vi.spyOn(Date, "now").mockReturnValue(review.expiresAt + 1);
    expect((await submit()).status).toBe(400); expect(decisions).toEqual([]);
  });
  it("never turns a file root grant or a user-input callback into one-shot approval", async () => {
    const { bridge, headers, query, notify, decisions } = await setup();
    notify(77, "item/fileChange/requestApproval", { threadId: "thread-1", turnId: "turn-1", grantRoot: "/sensitive" });
    const review = await (await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).json() as { reviewToken: string };
    const response = await send(`${bridge.localBaseUrl()}/admin/local-tasks/decision`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: bridge.workspace.id, threadId: "thread-1", requestId: "number:77", reviewToken: review.reviewToken, decision: "accept" }) });
    expect(response.status).toBe(400);
    notify(77, "item/tool/requestUserInput", { threadId: "thread-1", questions: [] });
    expect((await send(`${bridge.localBaseUrl()}/admin/local-tasks/review?${query}`, { headers })).status).toBe(400);
    expect(decisions).toEqual([]);
  });
});
