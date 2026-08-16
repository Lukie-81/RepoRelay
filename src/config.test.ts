import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const bridgeTestRoot = realpathSync.native(process.cwd());
const bridgeTestFile = join(emptyConfigDir, "not-a-directory.txt");
writeFileSync(bridgeTestFile, "fixture\n", "utf8");
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TOOL_MODE: "minimal",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: undefined }).toolMode,
  "chatgpt-review",
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "chatgpt-review" }).toolMode,
  "chatgpt-review",
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: undefined, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode,
  "full",
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: undefined, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode,
  "minimal",
);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).handoffWritesEnabled, false);
assert.equal(loadConfig(baseEnv).chatgptBridgeAuth, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents,
  true,
);

const reviewConfig = loadConfig({
  ...baseEnv,
  DEVSPACE_TOOL_MODE: "chatgpt-review",
  DEVSPACE_WIDGETS: "full",
  DEVSPACE_ARTIFACTS: "1",
  DEVSPACE_SKILLS: "1",
  DEVSPACE_SUBAGENTS: "1",
});
assert.equal(reviewConfig.host, "127.0.0.1");
assert.equal(reviewConfig.widgets, "off");
assert.equal(reviewConfig.artifactsEnabled, false);
assert.equal(reviewConfig.skillsEnabled, false);
assert.equal(reviewConfig.subagents, false);
assert.equal(reviewConfig.handoffWritesEnabled, false);
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_TOOL_MODE: "chatgpt-review",
    DEVSPACE_HANDOFF_WRITES: "1",
  }).handoffWritesEnabled,
  true,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "chatgpt-review", HOST: "0.0.0.0" }),
  /requires a loopback HOST/,
);

const chatgptBridgeEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  HOST: "127.0.0.1",
  DEVSPACE_TOOL_MODE: "chatgpt-review",
  DEVSPACE_HANDOFF_WRITES: "1",
  DEVSPACE_ALLOWED_ROOTS: bridgeTestRoot,
  DEVSPACE_CHATGPT_BRIDGE_AUTH: "1",
  DEVSPACE_CHATGPT_BRIDGE_SECRET: "b".repeat(64),
};
assert.equal(loadConfig(chatgptBridgeEnv).chatgptBridgeAuth, true);
assert.equal(loadConfig(chatgptBridgeEnv).handoffWritesEnabled, true);
assert.equal(loadConfig(chatgptBridgeEnv).chatgptBridgeWorkspaceRoot, bridgeTestRoot);
assert.deepEqual(loadConfig(chatgptBridgeEnv).allowedRoots, [bridgeTestRoot]);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_CHATGPT_BRIDGE_AUTH: "true" }),
  /must be exactly 1 to enable or 0 to disable/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, HOST: "localhost" }),
  /requires HOST exactly 127\.0\.0\.1/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_TOOL_MODE: "minimal" }),
  /requires DEVSPACE_TOOL_MODE exactly chatgpt-review/,
);
assert.equal(
  loadConfig({ ...chatgptBridgeEnv, DEVSPACE_HANDOFF_WRITES: "0" }).handoffWritesEnabled,
  false,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: undefined }),
  /requires exactly one DEVSPACE_ALLOWED_ROOTS entry/,
);
assert.throws(
  () => loadConfig({
    ...chatgptBridgeEnv,
    DEVSPACE_ALLOWED_ROOTS: `${bridgeTestRoot},${emptyConfigDir}`,
  }),
  /requires exactly one DEVSPACE_ALLOWED_ROOTS entry/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: "." }),
  /must be an absolute path/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: join(emptyConfigDir, "missing") }),
  /must be an existing directory/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: bridgeTestFile }),
  /must be an existing directory/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: parse(bridgeTestRoot).root }),
  /must not be a drive or filesystem root/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: homedir() }),
  /must not be the user home directory or one of its ancestors/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_ROOTS: dirname(homedir()) }),
  /must not be the user home directory or one of its ancestors/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_ALLOWED_HOSTS: "*" }),
  /forbids wildcard DEVSPACE_ALLOWED_HOSTS/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_PUBLIC_BASE_URL: "http://tunnel.example.com" }),
  /requires HTTPS for a non-loopback public URL/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_CHATGPT_BRIDGE_SECRET: undefined }),
  /must be at least 32 characters/,
);
assert.throws(
  () => loadConfig({ ...chatgptBridgeEnv, DEVSPACE_CHATGPT_BRIDGE_SECRET: "too-short" }),
  /must be at least 32 characters/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_CHATGPT_NO_AUTH: "1" }),
  /is no longer supported/,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { DEVSPACE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "devspace-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_TOOL_MODE: "minimal" });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
