import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { CHATGPT_BRIDGE_HEADER, createServer } from "./server.js";

const testRoot = resolve(process.env.DEVSPACE_TEST_ROOT ?? join(tmpdir(), "chatgpt-codex-mcp-tests"));
await mkdir(testRoot, { recursive: true });
const approvedRoot = realpathSync.native(testRoot);
const fixtureRoot = join(approvedRoot, ".chatgpt-bridge-auth-fixtures", randomUUID());
const workspaceRoot = join(fixtureRoot, "workspace");
const bridgeSecret = `${randomUUID()}${randomUUID()}`;
await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "preserved next task\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "preserved review\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "codex controlled\n", "utf8");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: join(fixtureRoot, "state"),
  HOST: "127.0.0.1",
  PORT: "7676",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  DEVSPACE_ALLOWED_HOSTS: "127.0.0.1",
  DEVSPACE_ALLOWED_ROOTS: approvedRoot,
  DEVSPACE_TOOL_MODE: "chatgpt-review",
  DEVSPACE_HANDOFF_WRITES: "1",
  DEVSPACE_CHATGPT_BRIDGE_AUTH: "1",
  DEVSPACE_CHATGPT_BRIDGE_SECRET: bridgeSecret,
  DEVSPACE_LOG_LEVEL: "silent",
});

assert.equal(config.chatgptBridgeAuth, true);
assert.throws(
  () => createServer({ ...config, host: "localhost" }),
  /requires HOST exactly 127\.0\.0\.1/,
  "HTTP server creation must recheck the bridge safety invariant",
);
assert.throws(
  () => createServer({ ...config, toolMode: "full" }),
  /requires DEVSPACE_TOOL_MODE exactly chatgpt-review/,
  "HTTP server creation must not allow a broader tool mode",
);
assert.throws(
  () => createServer({ ...config, allowedRoots: [approvedRoot, process.cwd()] }),
  /requires the only allowed root to match the operator-selected workspace root/,
  "HTTP server creation must not allow broader roots",
);
assert.throws(
  () => createServer({ ...config, allowedRoots: [process.cwd()] }),
  /requires the only allowed root to match the operator-selected workspace root/,
  "HTTP server creation must not allow the selected root to be replaced",
);
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
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chatgpt-bridge-auth-test", version: "1.0.0" },
    },
  });
  const requestHeaders = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };

  const missingHeader = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: requestHeaders,
    body: initializeBody,
  });
  assert.equal(missingHeader.status, 401, "MCP must reject a missing bridge header");

  const wrongHeader = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...requestHeaders, [CHATGPT_BRIDGE_HEADER]: `${bridgeSecret}-wrong` },
    body: initializeBody,
  });
  assert.equal(wrongHeader.status, 401, "MCP must reject an incorrect bridge secret");

  const duplicateHeaderStatus = await new Promise<number>((resolve, reject) => {
    const duplicateRequest = request(new URL(`${baseUrl}/mcp`), {
      method: "POST",
      headers: {
        ...requestHeaders,
        "content-length": Buffer.byteLength(initializeBody),
        [CHATGPT_BRIDGE_HEADER]: [bridgeSecret, bridgeSecret],
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    duplicateRequest.once("error", reject);
    duplicateRequest.end(initializeBody);
  });
  assert.equal(duplicateHeaderStatus, 401, "MCP must reject duplicate bridge headers");

  client = new Client({ name: "chatgpt-bridge-auth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { [CHATGPT_BRIDGE_HEADER]: bridgeSecret } } },
  ));
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "list_files",
      "open_workspace",
      "read_file",
      "search_files",
      "update_handoff_state",
      "write_next_task",
      "write_review",
    ],
  );
  assert.ok(!listed.tools.some((tool) => /shell|process|git|edit|delete|patch|artifact|worktree/i.test(tool.name)));
  for (const name of ["write_next_task", "write_review", "update_handoff_state"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["content", "workspaceId"]);
  }

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  assert.ok(opened.structuredContent);
  const workspaceId = String((opened.structuredContent as Record<string, unknown>).workspaceId);
  await client.callTool({
    name: "write_review",
    arguments: {
      workspaceId,
      content: "bridge-auth fixture review\n",
      path: ".ai-handoff/LUNA_RESULT.md",
      destination: "..\\outside.txt",
    },
  });
  assert.equal(
    await readFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "utf8"),
    "bridge-auth fixture review\n",
  );
  assert.equal(
    await readFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "utf8"),
    "codex controlled\n",
  );

  const oauthMetadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server/`);
  assert.equal(oauthMetadata.status, 404, "OAuth routes must not be registered in bridge mode");
} finally {
  await client?.close();
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((error) => error ? reject(error) : resolve());
    });
  }
  await running.close();
}

console.log(`Bridge-auth HTTP fixture preserved at ${fixtureRoot}`);
