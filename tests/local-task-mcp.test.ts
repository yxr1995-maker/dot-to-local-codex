import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { CodexLocalTasks, type AppServerConnection } from "../src/execution/codex-local-task.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const bridges: Bridge[] = [], clients: Client[] = [], dirs: string[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); for (const bridge of bridges.splice(0)) await bridge.close(); dirs.splice(0).forEach(cleanup); });
async function setup(scopes: string[]) {
  const root = makeTmpDir("local-mcp"); dirs.push(root);
  const calls: string[] = [];
  const host: AppServerConnection = {
    async request(method, params) {
      calls.push(method);
      if (params.threadId === "foreign") return { thread: { id: "foreign", cwd: "/Users/private-name/password=supersecret", turns: [] } };
      if (method === "thread/start") return { thread: { id: "local-thread", cwd: root, model: params.model, status: { type: "idle" }, turns: [] }, model: params.model, approvalPolicy: "on-request", sandbox: { type: "readOnly" }, approvalsReviewer: "auto_review" };
      if (method === "turn/start") return { turn: { id: "local-turn", status: "inProgress", items: [] } };
      return { thread: { id: "local-thread", cwd: root, status: { type: "idle" }, turns: [] } };
    },
    onNotification() {}, onServerRequest() {}, async close() {},
  };
  const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: path.join(root, "auth.json"), localTasks: new CodexLocalTasks(host) }); bridges.push(bridge);
  const token = bridge.authStore.issueTokens({ clientId: "test-client", scopes }).accessToken;
  const client = new Client({ name: "local-test", version: "1" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { bridge, client, calls };
}
describe("local tasks over authenticated MCP", () => {
  it("lists the four opt-in task tools and never exposes approval or raw RPC/shell tools", async () => {
    const { client } = await setup(["codex.local.read"]);
    const { tools } = await client.listTools(); const names = tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["codex_local_task_create", "codex_local_task_read", "codex_local_task_resume", "codex_local_task_status"]));
    expect(names.some(name => /approval|decision|shell|rpc/.test(name))).toBe(false);
    expect(tools.find(tool => tool.name === "codex_local_task_create")?.annotations?.readOnlyHint).toBe(false);
  });
  it("blocks existing read-only tokens before contacting the local host", async () => {
    const { client, calls } = await setup(["workspace.read", "execution.read", "codex.local.read"]);
    const result = await client.callTool({ name: "codex_local_task_create", arguments: { requestId: "create", prompt: "x", model: "jev-auto" } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE"); expect(calls).toHaveLength(0);
  });
  it("creates via an explicit write token and reuses the same requestId across stateless HTTP requests", async () => {
    const { client, calls } = await setup(["codex.local.write"]);
    const input = { name: "codex_local_task_create", arguments: { requestId: "create", prompt: "x", model: "jev-auto" } };
    const a = await client.callTool(input), b = await client.callTool(input);
    expect(a.isError).not.toBe(true); expect(a.structuredContent).toEqual(b.structuredContent);
    expect(a.structuredContent).toMatchObject({ threadId: "local-thread", model: "jev-auto", desktopGuiVisible: null });
    expect(calls).toEqual(["thread/start", "turn/start"]);
  });
  it("requires explicit local read scope and rejects an unknown workspace", async () => {
    const { client, calls } = await setup(["execution.read"]);
    const denied = await client.callTool({ name: "codex_local_task_read", arguments: { threadId: "local-thread" } });
    expect(JSON.stringify(denied)).toContain("INSUFFICIENT_SCOPE"); expect(calls).toHaveLength(0);
  });
  it("sanitizes rejected foreign cwd errors before returning them to MCP", async () => {
    const { client } = await setup(["codex.local.read"]);
    const result = await client.callTool({ name: "codex_local_task_read", arguments: { threadId: "foreign" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("supersecret"); expect(JSON.stringify(result)).not.toContain("private-name");
  });
});
