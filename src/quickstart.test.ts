import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} finally {
  await readOnlyRuntime.stop();
}

console.log(`Quickstart fixtures preserved at ${runRoot}`);
