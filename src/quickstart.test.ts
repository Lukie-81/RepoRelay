import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureQuickstartBridgeSecret,
  initializeHandoffFiles,
  startQuickstart,
} from "./quickstart.js";

const runRoot = await mkdtemp(join(tmpdir(), "reporelay-quickstart-test-"));
const workspace = join(runRoot, "workspace");
const secretFile = join(runRoot, "config", "reporelay-bridge-secret.txt");
const configEnv = { REPORELAY_CONFIG_DIR: join(runRoot, "config") };

const secret = await ensureQuickstartBridgeSecret(secretFile);
assert.ok(secret.length >= 32);
assert.equal(await ensureQuickstartBridgeSecret(secretFile), secret);
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

const runtime = await startQuickstart({ repositoryRoot: workspace, port: 17_776, secretFile, env: configEnv });
try {
  assert.equal(runtime.summary.repositoryRoot, workspace);
  assert.deepEqual(runtime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files", "update_handoff_state", "write_next_task", "write_review"]);
} finally {
  await runtime.stop();
}

const readOnlyRuntime = await startQuickstart({ repositoryRoot: workspace, port: 17_777, secretFile, handoffWrites: false, env: configEnv });
try {
  assert.deepEqual(readOnlyRuntime.summary.tools, ["list_files", "open_workspace", "read_file", "search_files"]);
} finally {
  await readOnlyRuntime.stop();
}

console.log(`Quickstart fixtures preserved at ${runRoot}`);
