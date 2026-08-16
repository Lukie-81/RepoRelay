import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { CHATGPT_BRIDGE_HEADER, createServer } from "./server.js";

const testRoot = resolve(process.env.DEVSPACE_TEST_ROOT ?? join(tmpdir(), "chatgpt-codex-mcp-tests"));
await mkdir(testRoot, { recursive: true });
const approvedRoot = realpathSync.native(testRoot);
const fixtureRoot = join(approvedRoot, ".chatgpt-release-runtime-fixtures", randomUUID());
const workspaceRoot = join(fixtureRoot, "workspace");
const siblingRoot = join(fixtureRoot, "sibling");
const missingTargetRoot = join(fixtureRoot, "missing-target-workspace");
const bridgeSecret = `${randomUUID()}${randomUUID()}`;
const secretMarker = `outside-${randomUUID()}`;

await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
await mkdir(join(missingTargetRoot, ".ai-handoff"), { recursive: true });
await mkdir(siblingRoot, { recursive: true });
await writeFile(join(workspaceRoot, "inside.txt"), "inside\n", "utf8");
await writeFile(join(siblingRoot, "outside.txt"), secretMarker, "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "review\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "codex-only\n", "utf8");
await writeFile(join(missingTargetRoot, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
await writeFile(join(missingTargetRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await writeFile(join(missingTargetRoot, ".ai-handoff", "LUNA_RESULT.md"), "codex-only\n", "utf8");
await symlink(siblingRoot, join(workspaceRoot, "junction-escape"), "junction");
await link(join(siblingRoot, "outside.txt"), join(workspaceRoot, "hard-link.txt"));

const configEnv = {
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: join(fixtureRoot, "state"),
  HOST: "127.0.0.1",
  PORT: "7677",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7677",
  DEVSPACE_ALLOWED_HOSTS: "127.0.0.1",
  DEVSPACE_ALLOWED_ROOTS: approvedRoot,
  DEVSPACE_TOOL_MODE: "chatgpt-review",
  DEVSPACE_HANDOFF_WRITES: "1",
  DEVSPACE_CHATGPT_BRIDGE_AUTH: "1",
  DEVSPACE_CHATGPT_BRIDGE_SECRET: bridgeSecret,
  DEVSPACE_LOG_LEVEL: "warn",
  DEVSPACE_LOG_FORMAT: "json",
};
const config = loadConfig(configEnv);
assert.deepEqual(config.allowedRoots, [approvedRoot]);
assert.equal(config.chatgptBridgeWorkspaceRoot, approvedRoot);
assert.throws(
  () => loadConfig({ ...configEnv, DEVSPACE_ALLOWED_ROOTS: `${approvedRoot},${fixtureRoot}` }),
  /requires exactly one DEVSPACE_ALLOWED_ROOTS entry/,
);
assert.throws(
  () => loadConfig({ ...configEnv, DEVSPACE_ALLOWED_ROOTS: parse(approvedRoot).root }),
  /must not be a drive or filesystem root/,
);
assert.throws(
  () => loadConfig({ ...configEnv, DEVSPACE_ALLOWED_ROOTS: homedir() }),
  /must not be the user home directory or one of its ancestors/,
);
assert.throws(
  () => loadConfig({ ...configEnv, DEVSPACE_ALLOWED_ROOTS: dirname(homedir()) }),
  /must not be the user home directory or one of its ancestors/,
);

const capturedLogs: string[] = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };

const running = createServer(config);
let httpServer: Server | undefined;
let client: Client | undefined;
try {
  httpServer = await new Promise<Server>((resolveServer, reject) => {
    const server = running.app.listen(7677, "127.0.0.1", () => resolveServer(server));
    server.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.port, 7677);

  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chatgpt-release-runtime-test", version: "1.0.0" },
    },
  });
  const requestHeaders = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };

  assert.equal((await fetch("http://127.0.0.1:7677/mcp", {
    method: "POST", headers: requestHeaders, body: initializeBody,
  })).status, 401);
  assert.equal((await fetch("http://127.0.0.1:7677/mcp", {
    method: "POST",
    headers: { ...requestHeaders, [CHATGPT_BRIDGE_HEADER]: `${bridgeSecret}-wrong` },
    body: initializeBody,
  })).status, 401);

  const duplicateStatus = await new Promise<number>((resolveStatus, reject) => {
    const duplicateRequest = request(new URL("http://127.0.0.1:7677/mcp"), {
      method: "POST",
      headers: {
        ...requestHeaders,
        "content-length": Buffer.byteLength(initializeBody),
        [CHATGPT_BRIDGE_HEADER]: [bridgeSecret, bridgeSecret],
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    duplicateRequest.once("error", reject);
    duplicateRequest.end(initializeBody);
  });
  assert.equal(duplicateStatus, 401);

  client = new Client({ name: "chatgpt-release-runtime-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:7677/mcp"),
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

  const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
  assert.ok(opened.structuredContent);
  const workspaceId = String((opened.structuredContent as Record<string, unknown>).workspaceId);
  for (const path of ["..\\sibling\\outside.txt", "junction-escape\\outside.txt", "hard-link.txt"]) {
    const result = await client.callTool({ name: "read_file", arguments: { workspaceId, path } });
    assert.equal(result.isError, true, `unsafe read unexpectedly succeeded: ${path}`);
  }
  const outsideOpen = await client.callTool({
    name: "open_workspace",
    arguments: { path: homedir() },
  });
  assert.equal(outsideOpen.isError, true, "MCP must not replace the selected root");

  await client.callTool({
    name: "write_review",
    arguments: {
      workspaceId,
      content: "runtime review\n",
      path: ".ai-handoff/LUNA_RESULT.md",
      destination: "..\\outside.txt",
    },
  });
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "utf8"), "runtime review\n");
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "utf8"), "codex-only\n");

  const missingOpened = await client.callTool({ name: "open_workspace", arguments: { path: missingTargetRoot } });
  assert.ok(missingOpened.structuredContent);
  const missingWorkspaceId = String((missingOpened.structuredContent as Record<string, unknown>).workspaceId);
  const missingWrite = await client.callTool({
    name: "write_review",
    arguments: { workspaceId: missingWorkspaceId, content: "must not create\n" },
  });
  assert.equal(missingWrite.isError, true);
  await assert.rejects(() => readFile(join(missingTargetRoot, ".ai-handoff", "REVIEW.md"), "utf8"));
} finally {
  await client?.close();
  if (httpServer) {
    await new Promise<void>((resolveClose, reject) => {
      httpServer?.close((error) => error ? reject(error) : resolveClose());
    });
  }
  await running.close();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

assert.ok(!capturedLogs.join("\n").includes(bridgeSecret), "runtime logs must not contain the bridge secret");
originalLog(`Release runtime fixture preserved at ${fixtureRoot}`);
