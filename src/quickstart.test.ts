import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ensureQuickstartBridgeSecret,
  initializeHandoffFiles,
  startQuickstart,
} from "./quickstart.js";

const execFileAsync = promisify(execFile);

async function findEphemeralPort(): Promise<number> {
  const server = createTcpServer();
  let listening = false;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        resolveListen();
      });
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Ephemeral test listener did not expose a TCP port.");
    return address.port;
  } finally {
    if (listening) await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
}

const runRoot = await realpath(await mkdtemp(join(tmpdir(), "reporelay-quickstart-test-")));
const workspace = join(runRoot, "workspace");
const secretFile = join(runRoot, "config", "reporelay-bridge-secret.txt");
const configEnv = { REPORELAY_CONFIG_DIR: join(runRoot, "config") };

const secret = await ensureQuickstartBridgeSecret(secretFile);
assert.ok(secret.length >= 32);
assert.equal(await ensureQuickstartBridgeSecret(secretFile), secret);
if (process.platform === "win32") {
  const { stdout: identityOutput } = await execFileAsync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
  const { stdout: aclOutput } = await execFileAsync("icacls.exe", [secretFile], { encoding: "utf8", windowsHide: true });
  assert.ok(aclOutput.toLowerCase().includes(identityOutput.trim().toLowerCase()));
  assert.match(aclOutput, /SYSTEM/i);
  assert.doesNotMatch(aclOutput, /Everyone|Authenticated Users|BUILTIN\\Users/i);
} else {
  await chmod(secretFile, 0o644);
  await ensureQuickstartBridgeSecret(secretFile);
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
}
await writeFile(join(runRoot, "short-secret.txt"), "short\n", "utf8");
await assert.rejects(() => ensureQuickstartBridgeSecret(join(runRoot, "short-secret.txt")), /shorter than 32 characters/);

const initial = await initializeHandoffFiles(workspace);
assert.deepEqual(initial.created.sort(), [
  ".ai-handoff/NEXT_TASK.md",
  ".ai-handoff/RESULT.md",
  ".ai-handoff/REVIEW.md",
  ".ai-handoff/STATE.json",
]);
assert.equal(initial.agentsAction, "create");
assert.ok((await readFile(join(workspace, "AGENTS.md"), "utf8")).includes("reporelay-handoff-v1"));
assert.ok((await readFile(join(workspace, ".ai-handoff", "RESULT.md"), "utf8")).startsWith("# Implementation result"));
const rerun = await initializeHandoffFiles(workspace);
assert.deepEqual(rerun.created, []);
assert.equal(rerun.preserved.length, 4);

const runtime = await startQuickstart({ repositoryRoot: workspace, port: await findEphemeralPort(), secretFile, env: configEnv });
try {
  assert.equal(runtime.summary.repositoryRoot, workspace);
  assert.deepEqual(runtime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files", "update_handoff_state", "write_next_task", "write_review"]);
} finally {
  await runtime.stop();
}

const readOnlyRuntime = await startQuickstart({ repositoryRoot: workspace, port: await findEphemeralPort(), secretFile, handoffWrites: false, env: configEnv });
try {
  assert.deepEqual(readOnlyRuntime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files"]);
  assert.equal(readOnlyRuntime.summary.handoffInit.agentsAction, "none");
} finally {
  await readOnlyRuntime.stop();
}

// Explicit read-only quickstart must leave a pristine repository unchanged:
// no .ai-handoff directory, no AGENTS.md, no other mutation.
const pristineRoot = await mkdtemp(join(tmpdir(), "reporelay-readonly-pristine-"));
const pristineWorkspace = join(pristineRoot, "workspace");
await mkdir(pristineWorkspace, { recursive: true });
await writeFile(join(pristineWorkspace, "README.md"), "pristine\n", "utf8");
const pristineEnv = { REPORELAY_CONFIG_DIR: join(pristineRoot, "config") };
const pristineSecretFile = join(pristineRoot, "config", "reporelay-bridge-secret.txt");
const pristineBefore = (await readdir(pristineWorkspace, { recursive: true })).sort();
const pristineRuntime = await startQuickstart({ repositoryRoot: pristineWorkspace, port: await findEphemeralPort(), secretFile: pristineSecretFile, handoffWrites: false, env: pristineEnv });
try {
  assert.deepEqual(pristineRuntime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files"]);
  assert.deepEqual(pristineRuntime.summary.handoffInit.created, []);
  assert.deepEqual(pristineRuntime.summary.handoffInit.preserved, []);
  assert.equal(pristineRuntime.summary.handoffInit.agentsAction, "none");
} finally {
  await pristineRuntime.stop();
}
const pristineAfter = (await readdir(pristineWorkspace, { recursive: true })).sort();
assert.deepEqual(pristineAfter, pristineBefore, "read-only quickstart must not create files in the repository");
assert.equal(existsSync(join(pristineWorkspace, ".ai-handoff")), false, "read-only quickstart must not initialize .ai-handoff");
assert.equal(existsSync(join(pristineWorkspace, "AGENTS.md")), false, "read-only quickstart must not create AGENTS.md");

// An existing AGENTS.md does not matter in explicit read-only mode: it is
// neither modified nor required to carry the RepoRelay marker.
const agentsRoot = await mkdtemp(join(tmpdir(), "reporelay-readonly-agents-"));
const agentsWorkspace = join(agentsRoot, "workspace");
await mkdir(agentsWorkspace, { recursive: true });
const agentsContent = "# Custom instructions\nKeep this untouched.\n";
await writeFile(join(agentsWorkspace, "AGENTS.md"), agentsContent, "utf8");
const agentsEnv = { REPORELAY_CONFIG_DIR: join(agentsRoot, "config") };
const readOnlyAgentsRuntime = await startQuickstart({ repositoryRoot: agentsWorkspace, port: await findEphemeralPort(), secretFile: join(agentsRoot, "config", "reporelay-bridge-secret.txt"), handoffWrites: false, env: agentsEnv });
try {
  assert.equal(readOnlyAgentsRuntime.summary.handoffInit.agentsAction, "none");
  assert.deepEqual(readOnlyAgentsRuntime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files"]);
} finally {
  await readOnlyAgentsRuntime.stop();
}
assert.equal(await readFile(join(agentsWorkspace, "AGENTS.md"), "utf8"), agentsContent, "read-only quickstart must not modify AGENTS.md");
assert.equal(existsSync(join(agentsWorkspace, ".ai-handoff")), false);

// A custom quickstart port is persisted for the managed tunnel and updates an
// existing tunnel configuration without touching its other fields.
const syncRoot = await mkdtemp(join(tmpdir(), "reporelay-endpoint-sync-"));
const syncWorkspace = join(syncRoot, "workspace");
await mkdir(syncWorkspace, { recursive: true });
const syncEnv = { REPORELAY_CONFIG_DIR: join(syncRoot, "config") };
const syncTunnelConfigFile = join(syncEnv.REPORELAY_CONFIG_DIR, "tunnel", "config.json");
await mkdir(dirname(syncTunnelConfigFile), { recursive: true });
const syncTunnelId = "tunnel_0123456789abcdef0123456789abcdef";
await writeFile(syncTunnelConfigFile, `${JSON.stringify({ schemaVersion: 1, tunnelId: syncTunnelId, profile: "reporelay", tunnelClientPath: process.execPath, localMcpUrl: "http://127.0.0.1:7676/mcp" }, null, 2)}\n`, "utf8");
const syncPort = await findEphemeralPort();
const syncRuntime = await startQuickstart({ repositoryRoot: syncWorkspace, port: syncPort, secretFile: join(syncRoot, "config", "reporelay-bridge-secret.txt"), env: syncEnv });
try {
  const activeEndpointFile = join(syncEnv.REPORELAY_CONFIG_DIR, "tunnel", "local-mcp-url.txt");
  assert.equal((await readFile(activeEndpointFile, "utf8")).trim(), `http://127.0.0.1:${syncPort}/mcp`);
  const updatedConfig = JSON.parse(await readFile(syncTunnelConfigFile, "utf8")) as { localMcpUrl?: string; tunnelId?: string; tunnelClientPath?: string };
  assert.equal(updatedConfig.localMcpUrl, `http://127.0.0.1:${syncPort}/mcp`);
  assert.equal(updatedConfig.tunnelId, syncTunnelId);
  assert.equal(updatedConfig.tunnelClientPath, process.execPath);
} finally {
  await syncRuntime.stop();
}

console.log(`Quickstart fixtures preserved at ${runRoot}`);
