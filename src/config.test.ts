import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { assertRepoRelaySafety, loadConfig } from "./config.js";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "reporelay-config-test-")));
const secret = "s".repeat(64);
const baseEnv: NodeJS.ProcessEnv = {
  REPORELAY_ALLOWED_ROOTS: root,
  REPORELAY_BRIDGE_SECRET: secret,
  REPORELAY_BRIDGE_AUTH: "1",
  REPORELAY_HOST: "127.0.0.1",
  REPORELAY_PORT: "17776",
  REPORELAY_PUBLIC_BASE_URL: "http://127.0.0.1:17776",
  REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
};

const config = loadConfig(baseEnv);
assert.equal(config.bridgeAuth, true);
assert.deepEqual(config.allowedRoots, [root]);
assert.equal(config.bridgeWorkspaceRoot, root);
assert.equal(config.handoffWritesEnabled, false);
assert.equal(config.logging.requests, true);
assert.equal(config.logging.toolCalls, true);
assert.equal(loadConfig({ ...baseEnv, REPORELAY_HANDOFF_WRITES: "1" }).handoffWritesEnabled, true);
assert.equal(loadConfig({ ...baseEnv, REPORELAY_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_ALLOWED_ROOTS: `${root},${root}` }),
  /exactly one approved repository root/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_ALLOWED_ROOTS: parse(root).root }),
  /must not be a drive or filesystem root/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_ALLOWED_ROOTS: homedir() }),
  /must not be the user home directory or one of its ancestors/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_ALLOWED_ROOTS: dirname(homedir()) }),
  /must not be the user home directory or one of its ancestors/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_BRIDGE_SECRET: "short" }),
  /at least 32 characters/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_BRIDGE_AUTH: "0" }),
  /never starts an unauthenticated bridge/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_ALLOWED_HOSTS: "*" }),
  /explicit host allowlist/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_HOST: "0.0.0.0" }),
  /requires REPORELAY_HOST exactly 127\.0\.0\.1/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, REPORELAY_PUBLIC_BASE_URL: "http://review.example.test" }),
  /requires HTTPS for a non-loopback public URL/,
);
assert.throws(
  () => assertRepoRelaySafety({ ...config, allowedRoots: [dirname(root)] }),
  /exactly one allowed root matching/,
);

console.log(`Config fixtures preserved at ${root}`);
