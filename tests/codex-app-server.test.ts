import { describe, it, expect, afterEach } from "vitest";
import { CodexAppServer } from "../src/execution/codex-app-server.js";
import { write, makeTmpDir, cleanup } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));
function fixture() {
  const root = makeTmpDir("app-server-fixture"); roots.push(root);
  const file = write(root, "host.cjs", `const readline = require('node:readline');
const output = value => process.stdout.write(JSON.stringify(value)+'\\n'); let decisions=[];
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (!request.method) { decisions.push(request.result); output({method:'turn/completed',params:{threadId:'one',turn:{id:'turn-one',status:'completed'}}}); return; }
 if (request.method === 'initialize') return output({id:request.id,result:{userAgent:'fixture'}});
 if (request.method === 'initialized') return;
 if (request.method === 'pending') { output({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'one',command:'npm install'}}); return output({id:request.id,result:{ok:true}}); }
 if (request.method === 'fail') return output({id:request.id,error:{code:-32602,message:'invalid model'}});
 if (request.method === 'exit') return process.exit(0);
 if (request.method === 'hang') return;
 if (request.method === 'decisions') return output({id:request.id,result:{decisions}});
 output({id:request.id,result:{method:request.method,params:request.params}});
});`);
  return { root, file };
}
describe("Codex app-server stdio adapter", () => {
  it("initializes once and multiplexes requests through a fixed argv, without a shell", async () => {
    const { root, file } = fixture();
    const host = new CodexAppServer({ command: process.execPath, args: [file], cwd: root });
    try {
      const [a, b] = await Promise.all([host.request("a", { model: "jev-auto" }), host.request("b", {})]);
      expect(a).toEqual({ method: "a", params: { model: "jev-auto" } }); expect(b.method).toBe("b");
    } finally { await host.close(); }
  });
  it("holds approval callbacks without automatically sending decisions", async () => {
    const { root, file } = fixture();
    const host = new CodexAppServer({ command: process.execPath, args: [file], cwd: root });
    const received: unknown[] = []; host.onServerRequest((id, method, params) => received.push({ id, method, params }));
    try { await host.request("pending", {}); expect(received).toEqual([{ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "one", command: "npm install" } }]); }
    finally { await host.close(); }
  });
  it("reports RPC errors, disconnects and bounded timeouts", async () => {
    const { root, file } = fixture();
    const host = new CodexAppServer({ command: process.execPath, args: [file], cwd: root, timeoutMs: 1000 });
    try {
      await expect(host.request("fail", {})).rejects.toMatchObject({ code: "APP_SERVER_RPC_ERROR" });
      await expect(host.request("hang", {})).rejects.toMatchObject({ code: "APP_SERVER_TIMEOUT" });
      await expect(host.request("exit", {})).rejects.toMatchObject({ code: "APP_SERVER_DISCONNECTED" });
    } finally { await host.close(); }
  });
  it("responds to exactly one pending approval after an explicit local one-shot decision", async () => {
    const { root, file } = fixture();
    const host = new CodexAppServer({ command: process.execPath, args: [file], cwd: root });
    try {
      await host.request("pending", {});
      expect((await host.request("decisions", {})).decisions).toEqual([]);
      await expect(host.resolveApproval(77, "acceptForSession" as never)).rejects.toMatchObject({ code: "INVALID_APPROVAL_DECISION" });
      await host.resolveApproval(77, "accept");
      expect((await host.request("decisions", {})).decisions).toEqual([{ decision: "accept" }]);
      await expect(host.resolveApproval(77, "accept")).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" });
      await expect(host.resolveApproval("77", "accept")).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" });
    } finally { await host.close(); }
  });
});
