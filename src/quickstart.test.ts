import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHATGPT_BRIDGE_HEADER } from "./server.js";
import {
  ensureQuickstartBridgeSecret,
  initializeHandoffFiles,
  startQuickstart,
} from "./quickstart.js";

const testRoot = realpathSync.native(
  process.env.DEVSPACE_TEST_ROOT ?? join(tmpdir(), "chatgpt-codex-mcp-tests"),
);
const fixtureRoot = join(testRoot, ".quickstart-fixtures", randomUUID());
const freshWorkspace = join(fixtureRoot, "fresh-workspace");
const guardedWorkspace = join(fixtureRoot, "guarded-workspace");
const preservedWorkspace = join(fixtureRoot, "preserved-workspace");
const configDir = join(fixtureRoot, "config");
const secretFile = join(fixtureRoot, "secrets", "bridge-secret.txt");
const shortSecretFile = join(fixtureRoot, "secrets", "short-secret.txt");

await mkdir(freshWorkspace, { recursive: true });
await mkdir(join(guardedWorkspace, ".ai-handoff"), { recursive: true });
await mkdir(join(preservedWorkspace, ".ai-handoff"), { recursive: true });
await writeFile(join(guardedWorkspace, "AGENTS.md"), "# Existing instructions\n", "utf8");
await writeFile(
  join(preservedWorkspace, ".ai-handoff", "NEXT_TASK.md"),
  "# Custom next task\n",
  "utf8",
);

const secret = await ensureQuickstartBridgeSecret(secretFile);
assert.ok(secret.length >= 32, "generated bridge secret must be at least 32 characters");
assert.equal(await ensureQuickstartBridgeSecret(secretFile), secret, "existing secret must be reused");
await writeFile(shortSecretFile, "too-short\n", "utf8");
await assert.rejects(
  () => ensureQuickstartBridgeSecret(shortSecretFile),
  /shorter than 32 characters/,
);

const freshInit = await initializeHandoffFiles(realpathSync.native(freshWorkspace));
assert.deepEqual(freshInit.created.sort(), [
  ".ai-handoff/LUNA_RESULT.md",
  ".ai-handoff/NEXT_TASK.md",
  ".ai-handoff/REVIEW.md",
  ".ai-handoff/STATE.json",
]);
assert.equal(freshInit.agentsAction, "create");
const agentsContent = await readFile(join(freshWorkspace, "AGENTS.md"), "utf8");
assert.ok(agentsContent.includes("<!-- devspace-chatgpt-handoff-v1 -->"));
assert.equal(
  (JSON.parse(await readFile(join(freshWorkspace, ".ai-handoff", "STATE.json"), "utf8")) as {
    phase: string;
  }).phase,
  "setup_required",
);

const reRunInit = await initializeHandoffFiles(realpathSync.native(freshWorkspace));
assert.deepEqual(reRunInit.created, []);
assert.deepEqual(reRunInit.preserved.sort(), [
  ".ai-handoff/LUNA_RESULT.md",
  ".ai-handoff/NEXT_TASK.md",
  ".ai-handoff/REVIEW.md",
  ".ai-handoff/STATE.json",
]);
assert.equal(reRunInit.agentsAction, "preserve-existing-marker");
assert.ok(
  (await readFile(join(freshWorkspace, ".ai-handoff", "NEXT_TASK.md"), "utf8"))
    .startsWith("# Next task"),
);

const preservedInit = await initializeHandoffFiles(realpathSync.native(preservedWorkspace));
assert.ok(preservedInit.preserved.includes(".ai-handoff/NEXT_TASK.md"));
assert.equal(
  await readFile(join(preservedWorkspace, ".ai-handoff", "NEXT_TASK.md"), "utf8"),
  "# Custom next task\n",
);

await assert.rejects(
  () => initializeHandoffFiles(realpathSync.native(guardedWorkspace)),
  /AGENTS\.md already exists/,
);
const appendedInit = await initializeHandoffFiles(realpathSync.native(guardedWorkspace), {
  appendAgentInstructions: true,
});
assert.equal(appendedInit.agentsAction, "backup-and-append");
assert.ok(appendedInit.agentsBackupPath);
const appendedAgents = await readFile(join(guardedWorkspace, "AGENTS.md"), "utf8");
assert.ok(appendedAgents.startsWith("# Existing instructions"));
assert.ok(appendedAgents.includes("<!-- devspace-chatgpt-handoff-v1 -->"));
assert.equal(
  await readFile(appendedInit.agentsBackupPath as string, "utf8"),
  "# Existing instructions\n",
);

const quickstartEnv = { DEVSPACE_CONFIG_DIR: configDir };
await assert.rejects(
  () => startQuickstart({ repositoryRoot: homedir(), port: 7690, secretFile, env: quickstartEnv }),
  /must not be the user home directory/,
);
await assert.rejects(
  () => startQuickstart({
    repositoryRoot: parse(realpathSync.native(freshWorkspace)).root,
    port: 7690,
    secretFile,
    env: quickstartEnv,
  }),
  /must not be a drive or filesystem root/,
);

const capturedLogs: string[] = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };

let runtime: Awaited<ReturnType<typeof startQuickstart>> | undefined;
try {
  runtime = await startQuickstart({
    repositoryRoot: freshWorkspace,
    port: 7690,
    secretFile,
    env: quickstartEnv,
  });
  assert.equal(runtime.summary.repositoryRoot, realpathSync.native(freshWorkspace));
  assert.equal(runtime.summary.localMcpUrl, "http://127.0.0.1:7690/mcp");
  assert.equal(runtime.summary.bridgeSecretFile, secretFile);
  assert.deepEqual(runtime.summary.tools, [
    "list_files",
    "open_workspace",
    "read_file",
    "search_files",
    "update_handoff_state",
    "write_next_task",
    "write_review",
  ]);

  await assert.rejects(
    () => startQuickstart({
      repositoryRoot: freshWorkspace,
      port: 7690,
      secretFile,
      env: quickstartEnv,
    }),
    /already in use/,
  );

  const client = new Client({ name: "quickstart-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:7690/mcp"), {
    requestInit: { headers: { [CHATGPT_BRIDGE_HEADER]: secret } },
  }));
  try {
    const opened = await client.callTool({
      name: "open_workspace",
      arguments: { path: realpathSync.native(freshWorkspace) },
    });
    const workspaceId = String(
      (opened.structuredContent as Record<string, unknown>).workspaceId,
    );
    await client.callTool({
      name: "write_review",
      arguments: { workspaceId, content: "quickstart review\n" },
    });
  } finally {
    await client.close();
  }
  assert.equal(
    await readFile(join(freshWorkspace, ".ai-handoff", "REVIEW.md"), "utf8"),
    "quickstart review\n",
  );
  assert.ok(
    (await readFile(join(freshWorkspace, ".ai-handoff", "LUNA_RESULT.md"), "utf8"))
      .startsWith("# Luna result"),
  );

  await runtime.stop();
  await assert.rejects(() => fetch("http://127.0.0.1:7690/healthz"), /fetch failed/);
  runtime = undefined;

  const readOnlyRuntime = await startQuickstart({
    repositoryRoot: freshWorkspace,
    port: 7691,
    secretFile,
    handoffWrites: false,
    env: quickstartEnv,
  });
  assert.deepEqual(readOnlyRuntime.summary.tools, [
    "list_files",
    "open_workspace",
    "read_file",
    "search_files",
  ]);
  await readOnlyRuntime.stop();
} finally {
  await runtime?.stop().catch(() => {});
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

assert.ok(!capturedLogs.join("\n").includes(secret), "quickstart logs must not contain the bridge secret");
originalLog(`Quickstart fixture preserved at ${fixtureRoot}`);
