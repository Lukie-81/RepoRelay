import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { REPORELAY_BRIDGE_HEADER, createServer } from "./server.js";

const runRoot = await mkdtemp(join(tmpdir(), "reporelay-bridge-auth-test-"));
const workspaceRoot = join(runRoot, "workspace");
const secret = `${randomUUID()}${randomUUID()}`;
await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
await writeFile(join(workspaceRoot, "inside.txt"), "inside\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "review\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "result\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");

const config = loadConfig({
  REPORELAY_ALLOWED_ROOTS: runRoot,
  REPORELAY_BRIDGE_SECRET: secret,
  REPORELAY_HANDOFF_WRITES: "1",
  REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
  REPORELAY_LOG_LEVEL: "silent",
});
assert.throws(() => createServer({ ...config, host: "localhost" }), /requires REPORELAY_HOST exactly 127\.0\.0\.1/);
assert.throws(() => createServer({ ...config, allowedRoots: [workspaceRoot] }), /exactly one allowed root matching/);

const running = createServer(config);
let httpServer: Server | undefined;
let client: Client | undefined;
try {
  httpServer = await new Promise<Server>((resolve, reject) => {
    const server = running.app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reporelay-auth-test", version: "1.0.0" } },
  });
  const requestHeaders = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  const missing = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: requestHeaders, body: initializeBody });
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...requestHeaders, [REPORELAY_BRIDGE_HEADER]: `${secret}-wrong` }, body: initializeBody });
  assert.equal(wrong.status, 401);
  const duplicate = await new Promise<number>((resolveStatus, reject) => {
    const duplicateRequest = request(new URL(`${baseUrl}/mcp`), {
      method: "POST",
      headers: { ...requestHeaders, "content-length": Buffer.byteLength(initializeBody), [REPORELAY_BRIDGE_HEADER]: [secret, secret] },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    duplicateRequest.once("error", reject);
    duplicateRequest.end(initializeBody);
  });
  assert.equal(duplicate, 401);

  client = new Client({ name: "reporelay-auth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { [REPORELAY_BRIDGE_HEADER]: secret } } }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["list_files", "open_workspace", "read_file", "search_files", "update_handoff_state", "write_next_task", "write_review"]);
  assert.ok(!listed.tools.some((tool) => /shell|process|git|edit|delete|patch|artifact|worktree|skill|subagent/i.test(tool.name)));
  for (const name of ["write_next_task", "write_review", "update_handoff_state"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["content", "workspaceId"]);
  }
  assert.equal((await fetch(`${baseUrl}/.well-known/oauth-authorization-server/`)).status, 404);
} finally {
  await client?.close();
  if (httpServer) {
    await new Promise<void>((resolveClose, reject) => httpServer?.close((error) => error ? reject(error) : resolveClose()));
  }
  await running.close();
}

console.log(`Bridge authentication fixtures preserved at ${runRoot}`);
