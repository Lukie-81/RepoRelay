import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { registerChatgptReviewTools } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

const configuredRoot = resolve(process.env.DEVSPACE_TEST_ROOT ?? join(tmpdir(), "chatgpt-codex-mcp-tests"));
await mkdir(configuredRoot, { recursive: true });
const approvedRoot = await realpath(configuredRoot);
const fixtureRoot = join(approvedRoot, ".mcp-profile-fixtures", randomUUID());
const workspaceRoot = join(fixtureRoot, "workspace");
const outsideRoot = join(fixtureRoot, "outside");
const secretMarker = `MCP_OUTSIDE_SECRET_${randomUUID()}`;
const environmentSecretMarker = `MCP_ENV_SECRET_${randomUUID()}`;

await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
await mkdir(outsideRoot, { recursive: true });
await writeFile(join(workspaceRoot, "inside.txt"), "inside marker\n", "utf8");
await writeFile(join(outsideRoot, "outside.txt"), secretMarker, "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "preserved next task\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "preserved review\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await writeFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "codex-only result\n", "utf8");
await symlink(outsideRoot, join(workspaceRoot, "escape"), process.platform === "win32" ? "junction" : "dir");

function reviewConfig(handoffWrites: boolean) {
  return loadConfig({
    ...process.env,
    HOST: "127.0.0.1",
    DEVSPACE_TOOL_MODE: "chatgpt-review",
    DEVSPACE_ALLOWED_ROOTS: approvedRoot,
    DEVSPACE_HANDOFF_WRITES: handoffWrites ? "1" : "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "local-mcp-profile-test-token",
    OPENAI_API_KEY: environmentSecretMarker,
    GH_TOKEN: environmentSecretMarker,
    DEVSPACE_ARTIFACTS: "0",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_WIDGETS: "off",
  });
}

async function connectReviewClient(handoffWrites: boolean) {
  const config = reviewConfig(handoffWrites);
  const registry = new WorkspaceRegistry(config);
  const server = new McpServer({ name: "devspace-profile-test", version: "1.0.0" });
  registerChatgptReviewTools(server, config, registry);
  const client = new Client({ name: "devspace-profile-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function structuredResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

async function assertToolFails(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
}

{
  const { client, server } = await connectReviewClient(false);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["list_files", "open_workspace", "read_file", "search_files"],
  );
  assert.ok(!listed.tools.some((tool) => /shell|process|write|delete|patch|environment/i.test(tool.name)));

  const opened = structuredResult(await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  }));
  const workspaceId = String(opened.workspaceId);

  const read = structuredResult(await client.callTool({
    name: "read_file",
    arguments: { workspaceId, path: "inside.txt" },
  }));
  assert.equal(read.result, "inside marker\n");

  await assertToolFails(client, "read_file", { workspaceId, path: join("..", "outside", "outside.txt") });
  await assertToolFails(client, "read_file", { workspaceId, path: join(outsideRoot, "outside.txt") });
  await assertToolFails(client, "read_file", { workspaceId, path: join("escape", "outside.txt") });

  const search = structuredResult(await client.callTool({
    name: "search_files",
    arguments: { workspaceId, query: secretMarker },
  }));
  assert.equal(search.result, "");
  assert.ok(!JSON.stringify({ listed, opened, read, search }).includes(environmentSecretMarker));

  const unknownWrite = await client.callTool({
    name: "write_file",
    arguments: { workspaceId, path: "created.txt", content: "must not write" },
  }).catch((error: unknown) => error);
  assert.ok(unknownWrite instanceof Error || (typeof unknownWrite === "object" && unknownWrite !== null));

  await client.close();
  await server.close();
}

{
  const { client, server } = await connectReviewClient(true);
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
  for (const name of ["write_next_task", "write_review", "update_handoff_state"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["content", "workspaceId"]);
  }

  const opened = structuredResult(await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  }));
  const workspaceId = String(opened.workspaceId);
  await client.callTool({
    name: "write_review",
    arguments: {
      workspaceId,
      content: "protocol-scoped review\n",
      path: join("..", "outside", "outside.txt"),
    },
  });
  await client.callTool({
    name: "write_next_task",
    arguments: {
      workspaceId,
      content: "fixture next task\n",
      destination: ".ai-handoff/LUNA_RESULT.md",
    },
  });
  await client.callTool({
    name: "update_handoff_state",
    arguments: {
      workspaceId,
      content: '{"phase":"fixture"}',
      filename: join("..", "created.json"),
    },
  });
  const review = structuredResult(await client.callTool({
    name: "read_file",
    arguments: { workspaceId, path: join(".ai-handoff", "REVIEW.md") },
  }));
  assert.equal(review.result, "protocol-scoped review\n");
  assert.equal(
    await readFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "utf8"),
    "fixture next task\n",
  );
  assert.equal(
    await readFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "utf8"),
    '{\n  "phase": "fixture"\n}\n',
  );
  assert.equal(
    await readFile(join(workspaceRoot, ".ai-handoff", "LUNA_RESULT.md"), "utf8"),
    "codex-only result\n",
  );
  const outside = await readFile(join(outsideRoot, "outside.txt"), "utf8");
  assert.equal(outside, secretMarker);

  const genericWrite = await client.callTool({
    name: "write_file",
    arguments: { workspaceId, path: "created.txt", content: "must not write" },
  }).catch((error: unknown) => error);
  assert.ok(genericWrite instanceof Error || (typeof genericWrite === "object" && genericWrite !== null));
  await assert.rejects(() => readFile(join(workspaceRoot, "created.txt"), "utf8"));

  await client.close();
  await server.close();
}

console.log(`MCP profile fixtures preserved at ${fixtureRoot}`);
