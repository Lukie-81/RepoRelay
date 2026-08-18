import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { ensureQuickstartBridgeSecret } from "./quickstart.js";
import { writeActiveLocalMcpUrl } from "./tunnel-config.js";
import {
  OFFICIAL_OPENAI_URLS,
  managedTunnelClientExecutablePath,
  resolveTunnelClientArtifact,
} from "./tunnel-client-install.js";
import { TunnelClientVerificationError } from "./tunnel-client-install.js";
import {
  buildTunnelClientArgs,
  buildTunnelProfile,
  doctorTunnel,
  getTunnelPaths,
  runTunnel,
  setupTunnel,
  type TunnelClientCommandResult,
} from "./tunnel.js";

const fixtureRoot = await mkdtemp(join(tmpdir(), "reporelay-tunnel-test-"));

const okRunCommand = async (): Promise<TunnelClientCommandResult> => ({ exitCode: 0, stdout: "doctor passed", stderr: "" });

// ---- Synthetic host-artifact archive ---------------------------------------

function buildArchive(): { zip: Buffer; sha256: string } {
  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  const entries: Array<{ name: string; data: Buffer; method: 0 | 8 }> = [
    { name: artifact.executable, data: Buffer.from("fake tunnel-client"), method: 0 },
    { name: artifact.companion, data: Buffer.from("fake cloudflared"), method: 8 },
    { name: "cloudflared-manifest.json", data: Buffer.from('{"version":"2026.7.2"}'), method: 0 },
    { name: "LICENSE", data: Buffer.from("MIT"), method: 0 },
  ];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const compressed = entry.method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(entry.method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuffer.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  const zip = Buffer.concat([...chunks, ...central, eocd]);
  return { zip, sha256: createHash("sha256").update(zip).digest("hex") };
}

const hostArchive = buildArchive();
const hostArtifact = resolveTunnelClientArtifact(process.platform, process.arch);
const verifyAgainstArchive = (buffer: Buffer) => {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== hostArchive.sha256) throw new TunnelClientVerificationError("test-expected-checksum", actual);
};

const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const runtimeApiKey = "sk-test-runtime-key-0123456789abcdef";

// ---- First-time interactive wizard happy path -------------------------------

const firstRoot = join(fixtureRoot, "first-time");
const firstEnv = { ...process.env, REPORELAY_CONFIG_DIR: firstRoot };
const firstPaths = getTunnelPaths(firstEnv);
await ensureQuickstartBridgeSecret(firstPaths.bridgeSecretFile);
const firstOutput: string[] = [];
const openedUrls: string[] = [];
let firstDownloadCalls = 0;
const first = await setupTunnel({
  env: firstEnv,
  interactive: true,
  output: (line) => firstOutput.push(line),
  readVisibleInput: async () => tunnelId,
  readHiddenInput: async () => runtimeApiKey,
  openUrl: async (_command, args) => {
    openedUrls.push(args[args.length - 1] ?? "");
    return true;
  },
  download: async () => {
    firstDownloadCalls += 1;
    return hostArchive.zip;
  },
  verify: verifyAgainstArchive,
  runCommand: okRunCommand,
});

assert.equal(first.doctorPassed, true);
assert.equal(first.config.tunnelId, tunnelId);
assert.equal(first.config.tunnelClientSource, "managed");
assert.equal(first.config.tunnelClientPath, managedTunnelClientExecutablePath(firstEnv));
assert.equal(first.config.localMcpUrl, "http://127.0.0.1:7676/mcp");
assert.equal(firstDownloadCalls, 1);
assert.deepEqual(openedUrls, [OFFICIAL_OPENAI_URLS.tunnels, OFFICIAL_OPENAI_URLS.apiKeys]);
assert.ok(firstOutput.includes("RepoRelay — Connect ChatGPT"));
assert.ok(firstOutput.includes("Checking local setup..."));
assert.ok(firstOutput.includes("✓ RepoRelay bridge found"));
assert.ok(firstOutput.includes("✓ Bridge authentication configured"));
assert.ok(firstOutput.includes("Preparing OpenAI tunnel client..."));
assert.ok(firstOutput.includes(`✓ Detected ${hostArtifact.platformLabel}`));
assert.ok(firstOutput.includes("✓ Downloading official OpenAI tunnel-client"));
assert.ok(firstOutput.includes("✓ Download verified"));
assert.ok(firstOutput.includes("✓ tunnel-client installed"));
assert.ok(firstOutput.includes("1. Create your OpenAI tunnel"));
assert.ok(firstOutput.includes("Opening OpenAI Platform..."));
assert.ok(firstOutput.includes("Create or select a Secure MCP Tunnel."));
assert.ok(firstOutput.includes("Tunnel ID:"));
assert.ok(firstOutput.includes("✓ Tunnel ID accepted"));
assert.ok(firstOutput.includes("2. Create your OpenAI runtime API key"));
assert.ok(firstOutput.includes("This key authenticates tunnel-client to OpenAI."));
assert.ok(firstOutput.includes("It is NOT the RepoRelay bridge secret."));
assert.ok(firstOutput.includes("Input is hidden; nothing will appear while you paste or type."));
assert.ok(firstOutput.includes("Runtime API key:"));
assert.ok(firstOutput.includes("✓ Runtime API key stored securely"));
assert.ok(firstOutput.includes("✓ RepoRelay bridge secret"));
assert.ok(firstOutput.includes("✓ Tunnel profile created"));
assert.ok(firstOutput.includes("Testing connection..."));
assert.ok(firstOutput.includes("✓ OpenAI runtime credential"));
assert.ok(firstOutput.includes("✓ RepoRelay reachable"));
assert.ok(firstOutput.includes("✓ Bridge authentication"));
assert.ok(firstOutput.includes("Setup complete."));
assert.ok(firstOutput.includes("  reporelay tunnel run"));
assert.equal(firstOutput.some((line) => line.includes("tunnel-client executable path")), false, "normal onboarding must not ask for an executable path");
assert.equal(firstOutput.some((line) => line.includes(runtimeApiKey)), false, "runtime key must never appear in output");
const firstBridgeSecret = (await readFile(firstPaths.bridgeSecretFile, "utf8")).trim();
assert.equal(firstOutput.some((line) => line.includes(firstBridgeSecret)), false, "bridge secret must never appear in output");

assert.equal((await readFile(firstPaths.runtimeApiKeyFile, "utf8")).trim(), runtimeApiKey);
const firstConfigText = await readFile(firstPaths.configFile, "utf8");
assert.doesNotMatch(firstConfigText, new RegExp(runtimeApiKey));
assert.doesNotMatch(firstConfigText, /api[_-]?key/i);
const firstProfileText = await readFile(firstPaths.profileFile, "utf8");
assert.match(firstProfileText, /api_key:\s+'file:/);
assert.match(firstProfileText, /X-RepoRelay-Bridge-Secret:\s+'file:/);
assert.doesNotMatch(firstProfileText, new RegExp(runtimeApiKey));
assert.doesNotMatch(firstProfileText, /\$BridgeHeader/);
assert.match(firstProfileText, /url: 'http:\/\/127\.0\.0\.1:7676\/mcp'/);

// ---- Repeat setup: reuse everything, no download, no browser, no prompts ----

const repeatOutput: string[] = [];
const repeat = await setupTunnel({
  env: firstEnv,
  interactive: true,
  output: (line) => repeatOutput.push(line),
  readVisibleInput: async () => {
    throw new Error("unexpected visible prompt on repeat setup");
  },
  readHiddenInput: async () => {
    throw new Error("unexpected hidden prompt on repeat setup");
  },
  openUrl: async () => {
    throw new Error("unexpected browser open on repeat setup");
  },
  download: async () => {
    throw new Error("unexpected redownload on repeat setup");
  },
  runCommand: okRunCommand,
});
assert.equal(repeat.doctorPassed, true);
assert.equal(repeat.config.tunnelId, tunnelId);
assert.equal(repeat.config.tunnelClientPath, first.config.tunnelClientPath);
assert.ok(repeatOutput.includes("✓ RepoRelay bridge found"));
assert.ok(repeatOutput.some((line) => line.includes("already installed")));
assert.ok(repeatOutput.includes("✓ Existing tunnel configuration"));
assert.ok(repeatOutput.includes("✓ Runtime credential found"));
assert.equal(repeatOutput.some((line) => line.includes("Opening OpenAI Platform...")), false, "repeat setup must not open OpenAI pages");
assert.ok(repeatOutput.includes("Setup complete."));

// ---- Replace tunnel / replace runtime key -----------------------------------

const replaceOutput: string[] = [];
const newTunnelId = "tunnel_ffffffffffffffffffffffffffffffff";
const newRuntimeKey = "sk-test-new-runtime-key-0000000000000000";
const replaceOpened: string[] = [];
const replaceResult = await setupTunnel({
  env: firstEnv,
  interactive: true,
  replaceTunnel: true,
  replaceRuntimeKey: true,
  output: (line) => replaceOutput.push(line),
  readVisibleInput: async () => newTunnelId,
  readHiddenInput: async () => newRuntimeKey,
  openUrl: async (_command, args) => {
    replaceOpened.push(args[args.length - 1] ?? "");
    return true;
  },
  runCommand: okRunCommand,
});
assert.equal(replaceResult.config.tunnelId, newTunnelId);
assert.equal(JSON.parse(await readFile(firstPaths.configFile, "utf8")).tunnelId, newTunnelId);
assert.equal((await readFile(firstPaths.runtimeApiKeyFile, "utf8")).trim(), newRuntimeKey);
assert.deepEqual(replaceOpened, [OFFICIAL_OPENAI_URLS.tunnels, OFFICIAL_OPENAI_URLS.apiKeys]);
assert.ok(replaceOutput.includes("✓ Runtime API key replaced"));
assert.equal(replaceOutput.some((line) => line.includes(runtimeApiKey)), false, "the old key must never be printed");
assert.equal(replaceOutput.some((line) => line.includes(newRuntimeKey)), false, "the new key must never be printed");

// ---- --no-open prevents browser launch --------------------------------------

const noOpenRoot = join(fixtureRoot, "no-open");
const noOpenEnv = { ...process.env, REPORELAY_CONFIG_DIR: noOpenRoot };
const noOpenPaths = getTunnelPaths(noOpenEnv);
await ensureQuickstartBridgeSecret(noOpenPaths.bridgeSecretFile);
const noOpenOutput: string[] = [];
const noOpenResult = await setupTunnel({
  env: noOpenEnv,
  interactive: true,
  noOpen: true,
  output: (line) => noOpenOutput.push(line),
  readVisibleInput: async () => tunnelId,
  readHiddenInput: async () => runtimeApiKey,
  openUrl: async () => {
    throw new Error("--no-open must prevent browser launch");
  },
  download: async () => hostArchive.zip,
  verify: verifyAgainstArchive,
  runCommand: okRunCommand,
});
assert.equal(noOpenResult.doctorPassed, true);
assert.equal(noOpenOutput.some((line) => line.includes("Opening OpenAI Platform...")), false);
assert.ok(noOpenOutput.includes("Create or select a Secure MCP Tunnel."));

// ---- Non-interactive mode never opens a browser -----------------------------

const nonInteractiveRoot = join(fixtureRoot, "non-interactive");
const nonInteractiveEnv = { ...process.env, REPORELAY_CONFIG_DIR: nonInteractiveRoot };
const nonInteractivePaths = getTunnelPaths(nonInteractiveEnv);
await ensureQuickstartBridgeSecret(nonInteractivePaths.bridgeSecretFile);
const nonInteractiveResult = await setupTunnel({
  env: nonInteractiveEnv,
  interactive: false,
  tunnelId,
  runtimeApiKey,
  output: () => undefined,
  openUrl: async () => {
    throw new Error("non-interactive mode must never open a browser");
  },
  download: async () => hostArchive.zip,
  verify: verifyAgainstArchive,
  runCommand: okRunCommand,
});
assert.equal(nonInteractiveResult.doctorPassed, true);
assert.equal(nonInteractiveResult.config.tunnelClientSource, "managed");

// ---- Tunnel ID validation loop ----------------------------------------------

const idLoopRoot = join(fixtureRoot, "id-validation");
const idLoopEnv = { ...process.env, REPORELAY_CONFIG_DIR: idLoopRoot };
const idLoopPaths = getTunnelPaths(idLoopEnv);
await ensureQuickstartBridgeSecret(idLoopPaths.bridgeSecretFile);
const idLoopOutput: string[] = [];
const idInputs = ["not-a-tunnel-id", "tunnel_short", tunnelId];
const idLoopResult = await setupTunnel({
  env: idLoopEnv,
  interactive: true,
  output: (line) => idLoopOutput.push(line),
  readVisibleInput: async () => idInputs.shift() ?? "",
  readHiddenInput: async () => runtimeApiKey,
  openUrl: async () => false,
  download: async () => hostArchive.zip,
  verify: verifyAgainstArchive,
  runCommand: okRunCommand,
});
assert.equal(idLoopResult.config.tunnelId, tunnelId);
assert.ok(idLoopOutput.some((line) => line.includes("does not look like a tunnel ID")));

// ---- Advanced override: custom --tunnel-client-path -------------------------

const customRoot = join(fixtureRoot, "custom-path");
const customEnv = { ...process.env, REPORELAY_CONFIG_DIR: customRoot };
const customPaths = getTunnelPaths(customEnv);
await ensureQuickstartBridgeSecret(customPaths.bridgeSecretFile);
const customOutput: string[] = [];
const customSetup = await setupTunnel({
  env: customEnv,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey,
  interactive: false,
  output: (line) => customOutput.push(line),
  download: async () => {
    throw new Error("custom tunnel-client must never trigger a download");
  },
  runCommand: okRunCommand,
});
assert.equal(customSetup.config.tunnelClientSource, "custom");
assert.equal(customSetup.config.tunnelClientPath, process.execPath);
assert.ok(customOutput.includes("✓ Using custom tunnel-client (advanced override)"));
assert.ok(customOutput.some((line) => line.includes("RepoRelay did not verify or manage this executable.")));

const invalidCustomRoot = join(fixtureRoot, "invalid-custom-path");
const invalidCustomEnv = { ...process.env, REPORELAY_CONFIG_DIR: invalidCustomRoot };
const invalidCustomPaths = getTunnelPaths(invalidCustomEnv);
await ensureQuickstartBridgeSecret(invalidCustomPaths.bridgeSecretFile);
await assert.rejects(
  () => setupTunnel({
    env: invalidCustomEnv,
    tunnelId,
    tunnelClientPath: join(invalidCustomRoot, "missing", "tunnel-client"),
    runtimeApiKey,
    interactive: false,
    output: () => undefined,
  }),
  /tunnel-client executable was not found/,
);

// ---- Automatic doctor failure is classified and setup still saves -----------

const doctorFailRoot = join(fixtureRoot, "doctor-failure");
const doctorFailEnv = { ...process.env, REPORELAY_CONFIG_DIR: doctorFailRoot };
const doctorFailPaths = getTunnelPaths(doctorFailEnv);
await ensureQuickstartBridgeSecret(doctorFailPaths.bridgeSecretFile);
const doctorFailOutput: string[] = [];
const doctorFailResult = await setupTunnel({
  env: doctorFailEnv,
  tunnelId,
  runtimeApiKey,
  interactive: false,
  output: (line) => doctorFailOutput.push(line),
  download: async () => hostArchive.zip,
  verify: verifyAgainstArchive,
  runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "mcp_server_reachable: connection refused" }),
});
assert.equal(doctorFailResult.doctorPassed, false);
assert.equal(JSON.parse(await readFile(doctorFailPaths.configFile, "utf8")).tunnelId, tunnelId, "configuration must be saved even when the connection test fails");
assert.ok(doctorFailOutput.some((line) => line.includes("RepoRelay is not currently running")));
assert.ok(doctorFailOutput.some((line) => line.includes("reporelay quickstart")));
assert.ok(doctorFailOutput.some((line) => line.includes("Setup was saved, but the connection test did not pass.")));
assert.ok(doctorFailOutput.some((line) => line.includes("reporelay tunnel doctor --verbose")));
assert.equal(doctorFailOutput.some((line) => line.includes(runtimeApiKey)), false);

const doctorAuthFailRoot = join(fixtureRoot, "doctor-auth-failure");
const doctorAuthFailEnv = { ...process.env, REPORELAY_CONFIG_DIR: doctorAuthFailRoot };
const doctorAuthFailPaths = getTunnelPaths(doctorAuthFailEnv);
await ensureQuickstartBridgeSecret(doctorAuthFailPaths.bridgeSecretFile);
const doctorAuthFailOutput: string[] = [];
const doctorAuthFailResult = await setupTunnel({
  env: doctorAuthFailEnv,
  tunnelId,
  runtimeApiKey,
  interactive: false,
  output: (line) => doctorAuthFailOutput.push(line),
  download: async () => hostArchive.zip,
  verify: verifyAgainstArchive,
  runCommand: async () => ({ exitCode: 1, stdout: "CHECK mcp_server_reachable FAIL HTTP 401", stderr: "" }),
});
assert.equal(doctorAuthFailResult.doctorPassed, false);
assert.ok(doctorAuthFailOutput.some((line) => line.includes("Bridge authentication failed")));

// ---- Install failure aborts before writing configuration --------------------

const installFailRoot = join(fixtureRoot, "install-failure");
const installFailEnv = { ...process.env, REPORELAY_CONFIG_DIR: installFailRoot };
const installFailPaths = getTunnelPaths(installFailEnv);
await ensureQuickstartBridgeSecret(installFailPaths.bridgeSecretFile);
await assert.rejects(
  () => setupTunnel({
    env: installFailEnv,
    tunnelId,
    runtimeApiKey,
    interactive: false,
    output: () => undefined,
    download: async () => {
      throw new Error("network unreachable");
    },
  }),
  /network unreachable/,
);
await assert.rejects(() => readFile(installFailPaths.configFile, "utf8"), /ENOENT/);

// ---- Custom port propagates through setup, doctor, and run ------------------

const customPortRoot = join(fixtureRoot, "custom-port");
const customPortEnv = { ...process.env, REPORELAY_CONFIG_DIR: customPortRoot };
const customPortPaths = getTunnelPaths(customPortEnv);
await ensureQuickstartBridgeSecret(customPortPaths.bridgeSecretFile);
const customPortSetup = await setupTunnel({
  env: customPortEnv,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: "custom-port-key",
  port: 7677,
  interactive: false,
  output: () => undefined,
  runCommand: okRunCommand,
});
assert.equal(customPortSetup.config.localMcpUrl, "http://127.0.0.1:7677/mcp");
assert.equal(JSON.parse(await readFile(customPortPaths.configFile, "utf8")).localMcpUrl, "http://127.0.0.1:7677/mcp");
assert.match(await readFile(customPortPaths.profileFile, "utf8"), /url: 'http:\/\/127\.0\.0\.1:7677\/mcp'/);

const doctorEndpointOutput: string[] = [];
const doctorEndpointPassed = await doctorTunnel({
  env: customPortEnv,
  output: (line) => doctorEndpointOutput.push(line),
  runCommand: okRunCommand,
});
assert.equal(doctorEndpointPassed, true);
assert.ok(doctorEndpointOutput.includes("✓ Local MCP endpoint: http://127.0.0.1:7677/mcp"));

const runEndpointOutput: string[] = [];
const runEndpointExit = await runTunnel({
  env: customPortEnv,
  output: (line) => runEndpointOutput.push(line),
  spawnClient: async () => 0,
});
assert.equal(runEndpointExit, 0);
assert.ok(runEndpointOutput.includes("✓ Local MCP endpoint: http://127.0.0.1:7677/mcp"));

// A changed recorded endpoint migrates the profile on the next doctor run.
const migratedConfig = JSON.parse(await readFile(customPortPaths.configFile, "utf8")) as { localMcpUrl: string };
migratedConfig.localMcpUrl = "http://127.0.0.1:7678/mcp";
await writeFile(customPortPaths.configFile, `${JSON.stringify(migratedConfig, null, 2)}\n`, "utf8");
const migratedDoctorPassed = await doctorTunnel({
  env: customPortEnv,
  output: () => undefined,
  runCommand: okRunCommand,
});
assert.equal(migratedDoctorPassed, true);
assert.match(await readFile(customPortPaths.profileFile, "utf8"), /url: 'http:\/\/127\.0\.0\.1:7678\/mcp'/);

// ---- Non-loopback endpoint configuration is rejected everywhere -------------

assert.throws(() => buildTunnelProfile(firstPaths, tunnelId, "http://mcp.example.com/mcp"), /loopback host/);
const remoteRoot = join(fixtureRoot, "remote-endpoint");
const remoteEnv = { ...process.env, REPORELAY_CONFIG_DIR: remoteRoot };
const remotePaths = getTunnelPaths(remoteEnv);
await ensureQuickstartBridgeSecret(remotePaths.bridgeSecretFile);
await setupTunnel({
  env: remoteEnv,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: "remote-key",
  interactive: false,
  output: () => undefined,
  runCommand: okRunCommand,
});
const remoteConfig = JSON.parse(await readFile(remotePaths.configFile, "utf8")) as { localMcpUrl: string };
remoteConfig.localMcpUrl = "https://mcp.example.com/mcp";
await writeFile(remotePaths.configFile, `${JSON.stringify(remoteConfig, null, 2)}\n`, "utf8");
const remoteDoctorOutput: string[] = [];
const remoteDoctorPassed = await doctorTunnel({
  env: remoteEnv,
  output: (line) => remoteDoctorOutput.push(line),
  runCommand: okRunCommand,
});
assert.equal(remoteDoctorPassed, false);
assert.ok(remoteDoctorOutput.some((line) => line.includes("loopback host")));
await assert.rejects(
  () => runTunnel({ env: remoteEnv, output: () => undefined, spawnClient: async () => 0 }),
  /loopback host/,
);

// ---- A quickstart-persisted active endpoint is picked up by tunnel setup ----

const hintRoot = join(fixtureRoot, "endpoint-hint");
const hintEnv = { ...process.env, REPORELAY_CONFIG_DIR: hintRoot };
const hintPaths = getTunnelPaths(hintEnv);
await ensureQuickstartBridgeSecret(hintPaths.bridgeSecretFile);
await writeActiveLocalMcpUrl(hintEnv, "http://127.0.0.1:7777/mcp");
const hintSetup = await setupTunnel({
  env: hintEnv,
  tunnelId,
  tunnelClientPath: process.execPath,
  runtimeApiKey: "hint-key",
  interactive: false,
  output: () => undefined,
  runCommand: okRunCommand,
});
assert.equal(hintSetup.config.localMcpUrl, "http://127.0.0.1:7777/mcp");

// ---- Existing default configurations remain compatible ----------------------

const legacyRoot = join(fixtureRoot, "legacy-config");
const legacyEnv = { ...process.env, REPORELAY_CONFIG_DIR: legacyRoot };
const legacyPaths = getTunnelPaths(legacyEnv);
await ensureQuickstartBridgeSecret(legacyPaths.bridgeSecretFile);
await mkdir(legacyPaths.profileDir, { recursive: true });
await mkdir(legacyPaths.secretDir, { recursive: true });
await writeFile(legacyPaths.configFile, `${JSON.stringify({ schemaVersion: 1, tunnelId, profile: "reporelay", tunnelClientPath: process.execPath }, null, 2)}\n`, "utf8");
await writeFile(legacyPaths.profileFile, buildTunnelProfile(legacyPaths, tunnelId), "utf8");
await writeFile(legacyPaths.runtimeApiKeyFile, "legacy-runtime-key\n", "utf8");
const legacyDoctorOutput: string[] = [];
const legacyPassed = await doctorTunnel({
  env: legacyEnv,
  output: (line) => legacyDoctorOutput.push(line),
  runCommand: okRunCommand,
});
assert.equal(legacyPassed, true);
assert.ok(legacyDoctorOutput.includes("✓ Local MCP endpoint: http://127.0.0.1:7676/mcp"));
const legacyRunExit = await runTunnel({
  env: legacyEnv,
  output: () => undefined,
  spawnClient: async () => 0,
});
assert.equal(legacyRunExit, 0);

// Re-running setup on an existing configuration keeps the stored runtime key.
const existingKeyBefore = await readFile(firstPaths.runtimeApiKeyFile, "utf8");
const preserveSetup = await setupTunnel({
  env: firstEnv,
  tunnelId,
  runtimeApiKey: "a-different-key-that-must-not-replace-the-first",
  interactive: false,
  output: () => undefined,
  runCommand: okRunCommand,
});
assert.equal(preserveSetup.doctorPassed, true);
assert.equal(await readFile(firstPaths.runtimeApiKeyFile, "utf8"), existingKeyBefore);

// ---- Standalone doctor keeps working ----------------------------------------

const doctorOutput: string[] = [];
const doctorPassed = await doctorTunnel({
  env: firstEnv,
  output: (line) => doctorOutput.push(line),
  runCommand: async (executable, args) => {
    assert.equal(executable, managedTunnelClientExecutablePath(firstEnv));
    assert.deepEqual(args, buildTunnelClientArgs("doctor", getTunnelPaths(firstEnv)));
    return { exitCode: 0, stdout: "doctor passed", stderr: "" };
  },
});
assert.equal(doctorPassed, true);
assert.ok(doctorOutput.includes("✓ OpenAI runtime credential accepted"));
assert.ok(doctorOutput.includes("Ready."));

const bridgeModeDoctorOutput: string[] = [];
const bridgeModeDoctorPassed = await doctorTunnel({
  env: firstEnv,
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
  env: firstEnv,
  output: (line) => failedDoctorOutput.push(line),
  runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "mcp_server_reachable: connection refused" }),
});
assert.equal(doctorFailed, false);
assert.ok(failedDoctorOutput.some((line) => line.includes("Start RepoRelay")));
assert.ok(failedDoctorOutput.some((line) => line.includes("--verbose")));
assert.equal(failedDoctorOutput.some((line) => line.includes("connection refused")), false, "raw diagnostics must not leak to non-verbose output");

// ---- runTunnel uses the RepoRelay-managed executable ------------------------

const managedRunOutput: string[] = [];
let managedRunExecutable = "";
const managedRunExit = await runTunnel({
  env: firstEnv,
  output: (line) => managedRunOutput.push(line),
  spawnClient: async (executable) => {
    managedRunExecutable = executable;
    return 0;
  },
});
assert.equal(managedRunExit, 0);
assert.equal(managedRunExecutable, managedTunnelClientExecutablePath(firstEnv));
assert.ok(managedRunOutput.includes("✓ Forwarding RepoRelay MCP through the OpenAI Secure MCP Tunnel"));
assert.ok(managedRunOutput.some((line) => line.includes("Scan Tools")));

// ---- Existing inline secrets are never replaced -----------------------------

const profileBeforeInlineSecret = await readFile(firstPaths.profileFile, "utf8");
await writeFile(firstPaths.profileFile, profileBeforeInlineSecret.replace("api_key: 'file:", "api_key: 'inline-placeholder"), "utf8");
await assert.rejects(
  () => setupTunnel({
    env: firstEnv,
    tunnelId,
    runtimeApiKey: "another-placeholder",
    interactive: false,
    output: () => undefined,
    runCommand: okRunCommand,
  }),
  /inline secret and was not changed/,
);
assert.match(await readFile(firstPaths.profileFile, "utf8"), /inline-placeholder/);

// ---- Tunnel-ID syntax is validated before anything is persisted -------------

const invalidIdRoot = join(fixtureRoot, "invalid-tunnel-id");
const invalidIdEnv = { ...process.env, REPORELAY_CONFIG_DIR: invalidIdRoot };
const invalidIdPaths = getTunnelPaths(invalidIdEnv);
await ensureQuickstartBridgeSecret(invalidIdPaths.bridgeSecretFile);
await assert.rejects(
  () => setupTunnel({
    env: invalidIdEnv,
    tunnelId: "not-a-valid-tunnel-id",
    tunnelClientPath: process.execPath,
    runtimeApiKey: "key",
    interactive: false,
    output: () => undefined,
  }),
  /Tunnel ID must look like tunnel_/,
);
await assert.rejects(() => readFile(invalidIdPaths.configFile, "utf8"), /ENOENT/);
await assert.rejects(() => readFile(invalidIdPaths.profileFile, "utf8"), /ENOENT/);

// ---- Runtime API keys are never accepted on argv ----------------------------

for (const flag of ["--api-key", "--runtime-api-key", "--control-plane.api-key"]) {
  const argvRun = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "tunnel", "setup", flag, "sk-should-never-appear"],
    { cwd: process.cwd(), env: { ...process.env, REPORELAY_CONFIG_DIR: join(fixtureRoot, "argv-secret") }, encoding: "utf8" },
  );
  assert.notEqual(argvRun.status, 0, `${flag} must be rejected`);
  assert.match(argvRun.stdout + argvRun.stderr, /Do not pass runtime API keys on the command line/);
}

console.log(`Tunnel fixtures preserved at ${fixtureRoot}`);
