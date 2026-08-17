import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { registerRepoRelayTools } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const runRoot = await realpath(await mkdtemp(join(tmpdir(), "reporelay-mcp-tools-test-")));
const workspaceRoot = join(runRoot, "workspace");
const outsideRoot = join(runRoot, "outside");
const outsideMarker = `outside-${randomUUID()}`;
await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
await mkdir(outsideRoot, { recursive: true });
await writeFile(join(workspaceRoot, "inside.txt"), "inside marker\n", "utf8");
await writeFile(join(outsideRoot, "outside.txt"), outsideMarker, "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "review\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "implementer result\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await symlink(outsideRoot, join(workspaceRoot, "escape"), process.platform === "win32" ? "junction" : "dir");

const secret = "m".repeat(64);
function makeConfig(handoffWrites: boolean) {
  return loadConfig({
    REPORELAY_ALLOWED_ROOTS: runRoot,
    REPORELAY_BRIDGE_SECRET: secret,
    REPORELAY_HANDOFF_WRITES: handoffWrites ? "1" : "0",
    REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
  });
}

async function connect(handoffWrites: boolean) {
  const config = makeConfig(handoffWrites);
  const server = new McpServer({ name: "reporelay-test", version: "1.0.0" });
  registerRepoRelayTools(server, config, new WorkspaceRegistry(config));
  const client = new Client({ name: "reporelay-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

const readOnly = await connect(false);
try {
  const listed = await readOnly.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["list_files", "open_workspace", "read_file", "search_files"]);
  assert.ok(!listed.tools.some((tool) => /shell|process|git|edit|delete|patch|artifact|worktree|skill|subagent/i.test(tool.name)));
  const opened = structured(await readOnly.client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } }));
  const workspaceId = String(opened.workspaceId);
  assert.equal(structured(await readOnly.client.callTool({ name: "read_file", arguments: { workspaceId, path: "inside.txt" } })).result, "inside marker\n");
  for (const path of ["../outside/outside.txt", join(outsideRoot, "outside.txt"), "escape/outside.txt", ".ai-handoff/RESULT.md"]) {
    const result = await readOnly.client.callTool({ name: "read_file", arguments: { workspaceId, path } });
    if (path.endsWith("RESULT.md")) assert.equal(result.isError, undefined);
    else assert.equal(result.isError, true, `unsafe read unexpectedly succeeded: ${path}`);
  }
  const search = structured(await readOnly.client.callTool({ name: "search_files", arguments: { workspaceId, query: outsideMarker } }));
  assert.equal(search.result, "No matches.");
  const unknownWrite = await readOnly.client.callTool({ name: "write_file", arguments: { workspaceId, path: "created.txt", content: "must not write" } }).catch((error: unknown) => error);
  assert.ok(unknownWrite instanceof Error || (typeof unknownWrite === "object" && unknownWrite !== null));
} finally {
  await readOnly.client.close();
  await readOnly.server.close();
}

const handoff = await connect(true);
try {
  const listed = await handoff.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["list_files", "open_workspace", "read_file", "search_files", "update_handoff_state", "write_next_task", "write_review"]);
  for (const name of ["write_next_task", "write_review", "update_handoff_state"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["content", "workspaceId"]);
  }
  const opened = structured(await handoff.client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } }));
  const workspaceId = String(opened.workspaceId);
  await handoff.client.callTool({ name: "write_review", arguments: { workspaceId, content: "new review\n", destination: "../outside.txt" } });
  await handoff.client.callTool({ name: "write_next_task", arguments: { workspaceId, content: "new task\n", path: ".ai-handoff/RESULT.md" } });
  await handoff.client.callTool({ name: "update_handoff_state", arguments: { workspaceId, content: '{"phase":"ready_for_review"}', filename: "outside.json" } });
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "utf8"), "new review\n");
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "utf8"), "new task\n");
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "utf8"), '{\n  "phase": "ready_for_review"\n}\n');
  assert.equal(await readFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "utf8"), "implementer result\n");
  assert.equal(await readFile(join(outsideRoot, "outside.txt"), "utf8"), outsideMarker);
} finally {
  await handoff.client.close();
  await handoff.server.close();
}

console.log(`MCP tool fixtures preserved at ${runRoot}`);
