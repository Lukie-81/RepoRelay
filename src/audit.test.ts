import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSecurityAudit,
  resolveAuditBridgeSecret,
  runSecurityAudit,
} from "./audit.js";

const runRoot = await mkdtemp(join(tmpdir(), "reporelay-audit-test-"));
const workspace = join(runRoot, "workspace");
await mkdir(join(workspace, "src"), { recursive: true });
await writeFile(join(workspace, "README.md"), "audit fixture\n", "utf8");
await writeFile(join(workspace, "src", "sample.ts"), "export const marker = true;\n", "utf8");

const secret = randomBytes(32).toString("base64url");
const secretFile = join(runRoot, "secrets", "bridge-secret.txt");
await mkdir(join(runRoot, "secrets"), { recursive: true });
await writeFile(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
const auditFixturePrefix = "reporelay-audit-fixture-";
const fixtureNamesBeforeAudit = new Set(
  (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(auditFixturePrefix))
    .map((entry) => entry.name),
);

const good = await runSecurityAudit({
  repositoryRoot: workspace,
  bridgeSecret: secret,
  env: {
    REPORELAY_HOST: "127.0.0.1",
    REPORELAY_BRIDGE_AUTH: "1",
    REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
    REPORELAY_HANDOFF_WRITES: "1",
  },
});
assert.equal(good.passed, true);
assert.equal(good.schemaVersion, 1);
assert.ok(good.checks.some((check) => check.id === "bridge.auth.missing" && check.status === "pass"));
assert.ok(good.checks.some((check) => check.id === "bridge.auth.duplicate" && check.status === "pass"));
assert.ok(good.checks.some((check) => check.id === "containment.symlink_junction" && check.status === "pass"));
assert.ok(good.checks.some((check) => check.id === "containment.fixture_cleanup" && check.status === "pass"));
assert.ok(good.checks.some((check) => check.id === "handoff.agent_result_protected" && check.status === "pass"));
assert.match(formatSecurityAudit(good), /RESULT: PASS/);
assert.doesNotMatch(JSON.stringify(good), new RegExp(secret));
const fixtureNamesAfterAudit = new Set(
  (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(auditFixturePrefix))
    .map((entry) => entry.name),
);
assert.deepEqual(
  [...fixtureNamesAfterAudit].filter((name) => !fixtureNamesBeforeAudit.has(name)),
  [],
  "a successful audit must remove its disposable adversarial fixture",
);

const readOnly = await runSecurityAudit({
  repositoryRoot: workspace,
  bridgeSecret: secret,
  handoffWrites: false,
  env: { REPORELAY_HOST: "127.0.0.1", REPORELAY_BRIDGE_AUTH: "1" },
});
assert.equal(readOnly.passed, true);
assert.ok(readOnly.checks.some((check) => check.id === "handoff.fixed_destinations" && check.message.includes("disabled")));

const unsafeRoot = await runSecurityAudit({
  repositoryRoot: homedir(),
  bridgeSecret: secret,
  env: { REPORELAY_HOST: "127.0.0.1", REPORELAY_BRIDGE_AUTH: "1" },
});
assert.equal(unsafeRoot.passed, false);
assert.ok(unsafeRoot.checks.some((check) => check.id === "repository.root" && check.status === "fail"));

const publicHost = await runSecurityAudit({
  repositoryRoot: workspace,
  bridgeSecret: secret,
  env: { REPORELAY_HOST: "0.0.0.0", REPORELAY_BRIDGE_AUTH: "1" },
});
assert.equal(publicHost.passed, false);
assert.ok(publicHost.checks.some((check) => check.id === "bridge.loopback.configured" && check.status === "fail"));

const unauthenticated = await runSecurityAudit({
  repositoryRoot: workspace,
  bridgeSecret: secret,
  env: { REPORELAY_HOST: "127.0.0.1", REPORELAY_BRIDGE_AUTH: "0" },
});
assert.equal(unauthenticated.passed, false);
assert.ok(unauthenticated.checks.some((check) => check.id === "bridge.auth.enabled" && check.status === "fail"));

const resolvedSecret = await resolveAuditBridgeSecret({ secretFile });
assert.equal(resolvedSecret.secret, secret);
const missingSecret = await resolveAuditBridgeSecret({ secretFile: join(runRoot, "missing-secret.txt") });
assert.equal(missingSecret.secret, undefined);
assert.ok(missingSecret.error);

const childEnv = { ...process.env };
delete childEnv.REPORELAY_BRIDGE_SECRET;
delete childEnv.REPORELAY_ALLOWED_ROOTS;
delete childEnv.REPORELAY_HOST;
delete childEnv.REPORELAY_BRIDGE_AUTH;
delete childEnv.REPORELAY_HANDOFF_WRITES;
const jsonRun = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "audit", workspace, "--secret-file", secretFile, "--json"],
  { cwd: process.cwd(), env: childEnv, encoding: "utf8" },
);
assert.equal(jsonRun.status, 0, jsonRun.stderr);
const jsonReport = JSON.parse(jsonRun.stdout) as { passed: boolean; checks: unknown[] };
assert.equal(jsonReport.passed, true);
assert.ok(Array.isArray(jsonReport.checks));
assert.doesNotMatch(jsonRun.stdout, new RegExp(secret));

const invalidDoctor = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "doctor"],
  { cwd: process.cwd(), env: { ...childEnv, REPORELAY_ALLOWED_ROOTS: workspace }, encoding: "utf8" },
);
assert.notEqual(invalidDoctor.status, 0);
assert.match(invalidDoctor.stdout, /Configuration: invalid/);

const validDoctor = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "doctor"],
  {
    cwd: process.cwd(),
    env: {
      ...childEnv,
      REPORELAY_ALLOWED_ROOTS: workspace,
      REPORELAY_HOST: "127.0.0.1",
      REPORELAY_BRIDGE_AUTH: "1",
      REPORELAY_BRIDGE_SECRET: secret,
      REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
    },
    encoding: "utf8",
  },
);
assert.equal(validDoctor.status, 0, validDoctor.stderr);
assert.match(validDoctor.stdout, /Configuration: valid/);
assert.doesNotMatch(validDoctor.stdout, new RegExp(secret));

const failedJsonRun = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "audit", workspace, "--secret-file", secretFile, "--json"],
  {
    cwd: process.cwd(),
    env: { ...childEnv, REPORELAY_HOST: "0.0.0.0" },
    encoding: "utf8",
  },
);
assert.notEqual(failedJsonRun.status, 0);
const failedReport = JSON.parse(failedJsonRun.stdout) as { passed: boolean };
assert.equal(failedReport.passed, false);

console.log(`Audit fixtures preserved at ${runRoot}`);
