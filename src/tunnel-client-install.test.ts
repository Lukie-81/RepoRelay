import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import {
  OFFICIAL_OPENAI_URLS,
  defaultOpenCommand,
  SUPPORTED_TUNNEL_CLIENT,
  TunnelClientVerificationError,
  downloadToBuffer,
  ensureManagedTunnelClient,
  isManagedTunnelClientPath,
  managedTunnelClientBinDir,
  managedTunnelClientExecutablePath,
  managedTunnelClientVersionDir,
  openOfficialUrl,
  resolveTunnelClientArtifact,
  tunnelClientArtifactUrl,
  verifySha256,
} from "./tunnel-client-install.js";
import { pathExists } from "./tunnel-config.js";

// ---- Artifact selection -----------------------------------------------------

const expected = {
  "windows-amd64": { file: "tunnel-client-v0.0.11-windows-amd64.zip", sha256: "eb912c86c6ccde90cda805cb17009507176a656725cf86c36fabe1901a12e29b", executable: "tunnel-client.exe", companion: "cloudflared.exe", label: "Windows AMD64" },
  "windows-arm64": { file: "tunnel-client-v0.0.11-windows-arm64.zip", sha256: "38f015a720404c8ccd5976a0d6aed18d931899697eaf208548b5eb3d0f6e8592", executable: "tunnel-client.exe", companion: "cloudflared.exe", label: "Windows ARM64" },
  "darwin-amd64": { file: "tunnel-client-v0.0.11-darwin-amd64.zip", sha256: "a48c8a37983d9bf9442309cb661cd2f14d7321cfacf72375d7fa31a6a7420db0", executable: "tunnel-client", companion: "cloudflared", label: "macOS AMD64" },
  "darwin-arm64": { file: "tunnel-client-v0.0.11-darwin-arm64.zip", sha256: "3685443b057614ff932d2d477dab94be2082e60bcf4e8b4e378bebc89121b714", executable: "tunnel-client", companion: "cloudflared", label: "macOS ARM64" },
  "linux-amd64": { file: "tunnel-client-v0.0.11-linux-amd64.zip", sha256: "29adfe5c1399dfb9fda9383f230c324355912f50dc36e2e416b1f1322317b3c4", executable: "tunnel-client", companion: "cloudflared", label: "Linux AMD64" },
  "linux-arm64": { file: "tunnel-client-v0.0.11-linux-arm64.zip", sha256: "d8bba47b2a723799a372b0b87d7e4d69304093d3a28837237315fe5406d97e77", executable: "tunnel-client", companion: "cloudflared", label: "Linux ARM64" },
} as const;

const platformByKey: Record<string, NodeJS.Platform> = { windows: "win32", darwin: "darwin", linux: "linux" };
for (const [key, value] of Object.entries(expected)) {
  const [osKey, archKey] = key.split("-") as [string, string];
  const artifact = resolveTunnelClientArtifact(platformByKey[osKey]!, archKey === "amd64" ? "x64" : "arm64");
  assert.equal(artifact.key, key);
  assert.equal(artifact.file, value.file);
  assert.equal(artifact.executable, value.executable);
  assert.equal(artifact.companion, value.companion);
  assert.equal(artifact.platformLabel, value.label);
  assert.equal(tunnelClientArtifactUrl(artifact), `${SUPPORTED_TUNNEL_CLIENT.downloadBaseUrl}/${value.file}`);
  assert.equal(artifact.sha256, value.sha256);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
}

// Unsupported platform/arch combinations are rejected with a clear message.
for (const [platform, arch] of [["freebsd", "x64"], ["win32", "ia32"], ["linux", "s390x"], ["darwin", "mips"]] as const) {
  assert.throws(
    () => resolveTunnelClientArtifact(platform, arch),
    /does not support tunnel-client on .* Supported platforms: Windows, macOS, and Linux on amd64 and arm64/,
  );
}

// Exact pinned stable version; no prerelease/nightly/dev accidentally selected.
assert.equal(SUPPORTED_TUNNEL_CLIENT.version, "v0.0.11");
assert.doesNotMatch(SUPPORTED_TUNNEL_CLIENT.version, /dev|beta|alpha|rc|pre|nightly/i);
assert.deepEqual(Object.keys(SUPPORTED_TUNNEL_CLIENT.artifacts).sort(), [
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
]);
for (const artifact of Object.values(SUPPORTED_TUNNEL_CLIENT.artifacts)) {
  assert.ok(artifact.file.includes(SUPPORTED_TUNNEL_CLIENT.version), `artifact file must include pinned version: ${artifact.file}`);
}

// verifySha256 is exact and fail-closed.
verifySha256(Buffer.from("abc"), createHash("sha256").update("abc").digest("hex"));
assert.throws(() => verifySha256(Buffer.from("abc"), "0".repeat(64)), TunnelClientVerificationError);

// ---- In-memory archive builder for the host artifact -----------------------

function buildArchive(): { zip: Buffer; sha256: string } {
  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  const entries: Array<{ name: string; data: Buffer; method: 0 | 8 }> = [
    { name: artifact.executable, data: Buffer.from("fake tunnel-client binary"), method: 0 },
    { name: artifact.companion, data: Buffer.from("fake cloudflared binary"), method: 8 },
    { name: "cloudflared-manifest.json", data: Buffer.from('{"version":"2026.7.2"}'), method: 0 },
    { name: "LICENSE", data: Buffer.from("MIT license text"), method: 0 },
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
    local.writeUInt16LE(0, 28);
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
const fixtureRoot = await mkdtemp(join(tmpdir(), "reporelay-tunnel-client-install-test-"));

// The default verification compares against the pinned official checksum, which
// a synthetic test archive can never match. Tests inject a verification double
// that checks the buffer against the synthetic archive's own SHA-256, keeping
// the fail-closed flow fully exercised.
const verifyAgainstHostArchive = (buffer: Buffer, _expected: string) => {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== hostArchive.sha256) throw new TunnelClientVerificationError("test-expected-checksum", actual);
};

// ---- Fresh install: download, verify, extract, stage, atomic move ----------

const freshEnv = { ...process.env, REPORELAY_CONFIG_DIR: join(fixtureRoot, "fresh") };
const freshOutput: string[] = [];
let freshDownloadCalls = 0;
const freshResult = await ensureManagedTunnelClient({
  env: freshEnv,
  output: (line) => freshOutput.push(line),
  download: async () => {
    freshDownloadCalls += 1;
    return hostArchive.zip;
  },
  verify: verifyAgainstHostArchive,
});
assert.equal(freshResult.installed, true);
assert.equal(freshResult.path, managedTunnelClientExecutablePath(freshEnv));
assert.ok(freshOutput.includes("✓ Downloading official OpenAI tunnel-client"));
assert.ok(freshOutput.includes("✓ Download verified"));
assert.ok(freshOutput.includes("✓ tunnel-client installed"));
assert.equal(await pathExists(freshResult.path), true);
assert.equal(await pathExists(join(managedTunnelClientVersionDir(freshEnv), "cloudflared" + (process.platform === "win32" ? ".exe" : ""))), true);
assert.equal(await pathExists(join(managedTunnelClientVersionDir(freshEnv), "cloudflared-manifest.json")), true);
if (process.platform !== "win32") {
  const mode = (await stat(freshResult.path)).mode & 0o777;
  assert.equal(mode, 0o755, "managed tunnel-client must be executable on Unix");
}

// ---- Reuse: no redownload when the pinned install is already present -------

const reuseOutput: string[] = [];
let reuseDownloadCalls = 0;
const reuseResult = await ensureManagedTunnelClient({
  env: freshEnv,
  output: (line) => reuseOutput.push(line),
  download: async () => {
    reuseDownloadCalls += 1;
    return hostArchive.zip;
  },
  verify: verifyAgainstHostArchive,
});
assert.equal(reuseResult.installed, false);
assert.equal(reuseDownloadCalls, 0, "a valid existing install must not be redownloaded");
assert.ok(reuseOutput.includes(`✓ tunnel-client ${SUPPORTED_TUNNEL_CLIENT.version} already installed`));

// ---- Repair: a corrupt managed install is replaced safely ------------------

await rm(join(managedTunnelClientVersionDir(freshEnv), "LICENSE"), { force: true });
const repairOutput: string[] = [];
const repairResult = await ensureManagedTunnelClient({
  env: freshEnv,
  output: (line) => repairOutput.push(line),
  download: async () => hostArchive.zip,
  verify: verifyAgainstHostArchive,
});
assert.equal(repairResult.installed, true);
assert.equal(await pathExists(join(managedTunnelClientVersionDir(freshEnv), "LICENSE")), true);

// ---- Checksum failure: fail closed, nothing installed, staging cleaned -----

const badEnv = { ...process.env, REPORELAY_CONFIG_DIR: join(fixtureRoot, "bad-checksum") };
const tampered = Buffer.from(hostArchive.zip);
tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x00 ? 0x01 : 0x00;
const badOutput: string[] = [];
await assert.rejects(
  () => ensureManagedTunnelClient({
    env: badEnv,
    output: (line) => badOutput.push(line),
    download: async () => tampered,
    verify: verifyAgainstHostArchive,
  }),
  TunnelClientVerificationError,
);
assert.ok(badOutput.some((line) => line.includes("Downloading official OpenAI tunnel-client")));
assert.equal(badOutput.includes("✓ Download verified"), false);
assert.equal(await pathExists(managedTunnelClientVersionDir(badEnv)), false, "a failed verification must not leave an install");
assert.equal(await pathExists(managedTunnelClientExecutablePath(badEnv)), false, "a failed verification must never leave an executable");
if (await pathExists(managedTunnelClientBinDir(badEnv))) {
  const binEntries = await readdir(managedTunnelClientBinDir(badEnv), { withFileTypes: true });
  assert.equal(binEntries.some((entry) => entry.name.startsWith(".staging-")), false, "temporary staging must be cleaned up");
}

// ---- Download failure: temp state cleaned, error propagates ----------------

const dlFailEnv = { ...process.env, REPORELAY_CONFIG_DIR: join(fixtureRoot, "download-failure") };
await assert.rejects(
  () => ensureManagedTunnelClient({
    env: dlFailEnv,
    download: async () => {
      throw new Error("network down");
    },
  }),
  /network down/,
);
assert.equal(await pathExists(managedTunnelClientBinDir(dlFailEnv)), false);

// ---- Malicious archives are rejected during install ------------------------

function buildMaliciousArchive(entryName: string): Buffer {
  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  const names = [entryName, artifact.companion, "cloudflared-manifest.json", "LICENSE"];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from("x");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc32(data) >>> 0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuffer.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

for (const [label, entryName] of [["traversal", "../evil"], ["absolute", "/etc/evil"], ["unexpected", "random.exe"]] as const) {
  const maliciousEnv = { ...process.env, REPORELAY_CONFIG_DIR: join(fixtureRoot, `malicious-${label}`) };
  const maliciousArchive = buildMaliciousArchive(entryName);
  await assert.rejects(
    () => ensureManagedTunnelClient({
      env: maliciousEnv,
      download: async () => maliciousArchive,
      verify: () => undefined,
    }),
    /ZIP|entry/i,
    `malicious archive (${label}) must be rejected`,
  );
  assert.equal(await pathExists(managedTunnelClientVersionDir(maliciousEnv)), false, `malicious archive (${label}) must not install`);
  const binDir = managedTunnelClientBinDir(maliciousEnv);
  if (await pathExists(binDir)) {
    const entries = await readdir(binDir, { withFileTypes: true });
    assert.equal(entries.some((entry) => entry.name.startsWith(".staging-")), false, `malicious archive (${label}) staging must be cleaned`);
  }
}

// ---- Managed-path detection ------------------------------------------------

assert.equal(isManagedTunnelClientPath(managedTunnelClientExecutablePath(freshEnv), freshEnv), true);
assert.equal(isManagedTunnelClientPath(join(fixtureRoot, "other", "tunnel-client"), freshEnv), false);

// ---- downloadToBuffer guards ------------------------------------------------

const fetchImpl = async (url: string) => new Response(Buffer.from("data"), { status: 200, headers: { "content-type": "application/octet-stream" } }) as unknown as Response;
assert.equal((await downloadToBuffer("https://example.test/x", { fetchImpl })).toString(), "data");
await assert.rejects(
  () => downloadToBuffer("https://example.test/x", { fetchImpl: async () => new Response(null, { status: 404 }) }),
  /Download failed: HTTP 404/,
);
await assert.rejects(
  () => downloadToBuffer("https://example.test/x", { fetchImpl: async () => new Response(Buffer.alloc(0), { status: 200 }) }),
  /empty/,
);

// ---- Browser open helper ----------------------------------------------------

const opened: Array<{ command: string; args: string[] }> = [];
const recordOpen = async (command: string, args: string[]) => {
  opened.push({ command, args });
  return true;
};
const output: string[] = [];

assert.equal(await openOfficialUrl(OFFICIAL_OPENAI_URLS.tunnels, { interactive: true, openCommand: recordOpen }), true);
assert.equal(opened.length, 1);
assert.ok(opened[0]!.args.includes(OFFICIAL_OPENAI_URLS.tunnels));

await assert.rejects(
  () => openOfficialUrl("https://evil.example.com/phish", { interactive: true, openCommand: recordOpen }),
  /Refusing to open a non-official URL/,
);
assert.equal(opened.length, 1, "non-official URLs must never be opened");

assert.equal(await openOfficialUrl(OFFICIAL_OPENAI_URLS.apiKeys, { interactive: true, noOpen: true, openCommand: recordOpen }), false);
assert.equal(opened.length, 1, "--no-open must prevent browser launch");

assert.equal(await openOfficialUrl(OFFICIAL_OPENAI_URLS.tunnels, { interactive: false, openCommand: recordOpen }), false);
assert.equal(opened.length, 1, "non-interactive mode must never open a browser");

const fallbackOutput: string[] = [];
assert.equal(await openOfficialUrl(OFFICIAL_OPENAI_URLS.tunnels, { interactive: true, output: (line) => fallbackOutput.push(line), openCommand: async () => false }), false);
assert.ok(fallbackOutput.some((line) => line.includes("Could not open your browser automatically")));
assert.ok(fallbackOutput.some((line) => line.includes("Open this page manually")));
assert.ok(fallbackOutput.some((line) => line.includes(OFFICIAL_OPENAI_URLS.tunnels)));

// The real child-process lifecycle must keep the awaiting CLI alive until the
// browser launcher exits. Run the helper in an isolated process so a broken
// unref() implementation cannot make this assertion pass by exiting early.
const lifecycleProbeScript = [
  'import { defaultOpenCommand } from "./src/tunnel-client-install.ts";',
  'const opened = await defaultOpenCommand(process.execPath, ["-e", "setTimeout(() => process.exit(0), 50)"]);',
  'if (!opened) process.exit(1);',
  'process.stdout.write("continued");',
].join("\n");
const lifecycleProbe = spawnSync(
  process.execPath,
  ["--import", "tsx", "--eval", lifecycleProbeScript],
  { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 5_000 },
);
assert.equal(lifecycleProbe.error, undefined, `browser-launch lifecycle probe failed: ${lifecycleProbe.error?.message ?? "unknown error"}`);
assert.equal(lifecycleProbe.status, 0, lifecycleProbe.stderr);
assert.equal(lifecycleProbe.stdout, "continued", "setup must continue after the browser launcher exits");

console.log(`Tunnel-client install fixtures preserved at ${fixtureRoot}`);
