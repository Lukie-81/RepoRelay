import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureQuickstartBridgeSecret } from "./quickstart.js";
import {
  buildTunnelClientArgs,
  buildTunnelProfile,
  doctorTunnel,
  getTunnelPaths,
  runTunnel,
  setupTunnel,
} from "./tunnel.js";

const fixtureRoot = await mkdtemp(join(tmpdir(), "reporelay-tunnel-test-"));
const configRoot = join(fixtureRoot, "RepoRelay");
const env = { ...process.env, REPORELAY_CONFIG_DIR: configRoot };
const paths = getTunnelPaths(env);
const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const runtimePlaceholder = "placeholder-runtime-value";

await ensureQuickstartBridgeSecret(paths.bridgeSecretFile);
const setupOutput: string[] = [];
const setup = await setupTunnel({
  env,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: runtimePlaceholder,
  interactive: false,
  output: (line) => setupOutput.push(line),
});

assert.equal(setup.config.schemaVersion, 1);
assert.equal(setup.config.profile, "reporelay");
assert.equal(setup.config.tunnelId, tunnelId);
assert.equal(setup.config.tunnelClientPath, process.execPath);
assert.ok(setupOutput.includes("✓ Runtime API key stored securely"));
assert.ok(setupOutput.includes("✓ RepoRelay bridge secret found"));
assert.equal((await readFile(paths.runtimeApiKeyFile, "utf8")).trim(), runtimePlaceholder);

const configText = await readFile(paths.configFile, "utf8");
assert.doesNotMatch(configText, new RegExp(runtimePlaceholder));
assert.doesNotMatch(configText, /api[_-]?key/i);
const profileText = await readFile(paths.profileFile, "utf8");
assert.match(profileText, /config_version: 1/);
assert.match(profileText, /channel: main/);
assert.match(profileText, /api_key:\s+'file:/);
assert.match(profileText, /X-RepoRelay-Bridge-Secret:\s+'file:/);
assert.doesNotMatch(profileText, new RegExp(runtimePlaceholder));
assert.doesNotMatch(profileText, /\$BridgeHeader/);
assert.deepEqual(buildTunnelClientArgs("doctor", paths), [
  "doctor",
  "--profile",
  "reporelay",
  "--profile-dir",
  paths.profileDir,
  "--explain",
]);
assert.deepEqual(buildTunnelClientArgs("run", paths), [
  "run",
  "--profile",
  "reporelay",
  "--profile-dir",
  paths.profileDir,
]);
assert.equal(buildTunnelProfile(paths, tunnelId).includes(runtimePlaceholder), false);

await setupTunnel({
  env,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: "a-different-placeholder-that-must-not-replace-the-first",
  interactive: false,
  output: () => undefined,
});
assert.equal((await readFile(paths.runtimeApiKeyFile, "utf8")).trim(), runtimePlaceholder);

const doctorOutput: string[] = [];
const doctorPassed = await doctorTunnel({
  env,
  output: (line) => doctorOutput.push(line),
  runCommand: async (executable, args) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, buildTunnelClientArgs("doctor", paths));
    return { exitCode: 0, stdout: "doctor passed", stderr: "" };
  },
});
assert.equal(doctorPassed, true);
assert.ok(doctorOutput.includes("✓ OpenAI runtime credential accepted"));
assert.ok(doctorOutput.includes("Ready."));

const bridgeModeDoctorOutput: string[] = [];
const bridgeModeDoctorPassed = await doctorTunnel({
  env,
  output: (line) => bridgeModeDoctorOutput.push(line),
  runCommand: async () => ({
    exitCode: 2,
    stdout: [
      "FAILED_CHECKS oauth_metadata",
      "CHECK profile_load PASS",
      "CHECK control_plane_api_key PASS",
      "CHECK mcp_server_reachable PASS HTTP 401",
    ].join("\n"),
    stderr: "",
  }),
});
assert.equal(bridgeModeDoctorPassed, true);
assert.ok(bridgeModeDoctorOutput.includes("Ready."));

const failedDoctorOutput: string[] = [];
const doctorFailed = await doctorTunnel({
  env,
  output: (line) => failedDoctorOutput.push(line),
  runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "mcp_server_reachable: connection refused" }),
});
assert.equal(doctorFailed, false);
assert.ok(failedDoctorOutput.some((line) => line.includes("Start RepoRelay")));
assert.ok(failedDoctorOutput.some((line) => line.includes("--verbose")));
assert.equal(failedDoctorOutput.some((line) => line.includes("connection refused")), false);

const profileBeforeInlineSecret = await readFile(paths.profileFile, "utf8");
await writeFile(paths.profileFile, profileBeforeInlineSecret.replace("api_key: 'file:", "api_key: 'inline-placeholder"), "utf8");
await assert.rejects(
  () => setupTunnel({
    env,
    tunnelId,
    tunnelClientPath: process.execPath,
    runtimeApiKey: "another-placeholder",
    interactive: false,
    output: () => undefined,
  }),
  /inline secret and was not changed/,
);
assert.match(await readFile(paths.profileFile, "utf8"), /inline-placeholder/);

// Tunnel-ID syntax is validated before anything is persisted.
const invalidIdRoot = join(fixtureRoot, "invalid-tunnel-id");
const invalidIdEnv = { ...process.env, REPORELAY_CONFIG_DIR: invalidIdRoot };
const invalidIdPaths = getTunnelPaths(invalidIdEnv);
await assert.rejects(
  () => setupTunnel({
    env: invalidIdEnv,
    tunnelId: "not-a-valid-tunnel-id",
    tunnelClientPath: process.execPath,
    interactive: false,
    output: () => undefined,
  }),
  /Tunnel ID must look like tunnel_/,
);
await assert.rejects(() => readFile(invalidIdPaths.configFile, "utf8"), /ENOENT/);
await assert.rejects(() => readFile(invalidIdPaths.profileFile, "utf8"), /ENOENT/);

// Interactive setup prints cold-start hints and persists prompted values.
const interactiveRoot = join(fixtureRoot, "interactive-setup");
const interactiveEnv = { ...process.env, REPORELAY_CONFIG_DIR: interactiveRoot };
const interactivePaths = getTunnelPaths(interactiveEnv);
await ensureQuickstartBridgeSecret(interactivePaths.bridgeSecretFile);
const interactiveOutput: string[] = [];
await setupTunnel({
  env: interactiveEnv,
  tunnelClientPath: process.execPath,
  interactive: true,
  output: (line) => interactiveOutput.push(line),
  readVisibleInput: async () => tunnelId,
  readHiddenInput: async () => "interactive-runtime-key",
});
assert.ok(interactiveOutput.some((line) => line.includes("1. Tunnel ID")));
assert.ok(interactiveOutput.some((line) => line.includes("platform.openai.com/settings/organization/tunnels")));
assert.ok(interactiveOutput.some((line) => line.includes("2. Runtime API key")));
assert.ok(interactiveOutput.some((line) => line.includes("platform.openai.com/settings/organization/api-keys")));
assert.ok(interactiveOutput.some((line) => line.includes("Tunnels Read + Use")));
assert.ok(interactiveOutput.some((line) => line.includes("Runtime API key (input hidden):")));
assert.equal((await readFile(interactivePaths.runtimeApiKeyFile, "utf8")).trim(), "interactive-runtime-key");
assert.equal(JSON.parse(await readFile(interactivePaths.configFile, "utf8")).tunnelId, tunnelId);

// A successful run prints the ChatGPT Web completion checklist.
const runRoot = join(fixtureRoot, "run-setup");
const runEnv = { ...process.env, REPORELAY_CONFIG_DIR: runRoot };
const runPaths = getTunnelPaths(runEnv);
await ensureQuickstartBridgeSecret(runPaths.bridgeSecretFile);
await setupTunnel({
  env: runEnv,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: "run-runtime-key",
  interactive: false,
  output: () => undefined,
});
const runOutput: string[] = [];
const runExit = await runTunnel({
  env: runEnv,
  output: (line) => runOutput.push(line),
  spawnClient: async () => 0,
});
assert.equal(runExit, 0);
assert.ok(runOutput.includes("✓ Forwarding RepoRelay MCP through the OpenAI Secure MCP Tunnel"));
assert.ok(runOutput.some((line) => line.includes("ChatGPT Web completion checklist")));
assert.ok(runOutput.some((line) => line.includes("Scan Tools")));
assert.ok(runOutput.some((line) => line.includes("exactly 7")));
assert.ok(runOutput.some((line) => line.includes("exactly 4")));
assert.ok(runOutput.some((line) => line.includes("127.0.0.1")));
assert.ok(runOutput.some((line) => line.includes("never paste")));

console.log(`Tunnel fixtures preserved at ${fixtureRoot}`);
