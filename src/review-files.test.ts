import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ReviewAccessDeniedError,
  listReviewDirectory,
  readReviewTextFile,
  resolveReviewWorkspaceRoot,
  searchReviewFiles,
  writeHandoffDocument,
} from "./review-files.js";

const fixtureBase = process.env.DEVSPACE_TEST_ROOT ?? join(tmpdir(), "chatgpt-codex-mcp-tests");
const runRoot = join(fixtureBase, ".containment-fixtures", randomUUID());
let workspace = join(runRoot, "workspace");
let outside = join(runRoot, "outside");
let writeEscapeWorkspace = join(runRoot, "write-escape-workspace");
let missingTargetWorkspace = join(runRoot, "missing-target-workspace");
let hardLinkWriteWorkspace = join(runRoot, "hard-link-write-workspace");

await mkdir(join(workspace, ".ai-handoff"), { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(writeEscapeWorkspace, { recursive: true });
await mkdir(join(missingTargetWorkspace, ".ai-handoff"), { recursive: true });
await mkdir(join(hardLinkWriteWorkspace, ".ai-handoff"), { recursive: true });

// os.tmpdir() may be addressed through a symlinked parent on hosted runners
// (for example, /var versus /private/var on macOS). The review profile requires
// approved roots to be supplied by their canonical filesystem path, so the
// fixtures must model an operator-provided canonical root explicitly.
workspace = await realpath(workspace);
outside = await realpath(outside);
writeEscapeWorkspace = await realpath(writeEscapeWorkspace);
missingTargetWorkspace = await realpath(missingTargetWorkspace);
hardLinkWriteWorkspace = await realpath(hardLinkWriteWorkspace);

const nonCanonicalParent = join(runRoot, "non-canonical-parent");
await symlink(runRoot, nonCanonicalParent, process.platform === "win32" ? "junction" : "dir");
const nonCanonicalWorkspace = join(nonCanonicalParent, "workspace");
await assert.rejects(
  () => resolveReviewWorkspaceRoot(nonCanonicalWorkspace, [nonCanonicalWorkspace]),
  /must be addressed by its canonical filesystem path/,
);

await writeFile(join(workspace, "inside.txt"), "INSIDE_MARKER\n", "utf8");
await writeFile(join(workspace, ".env"), "SENSITIVE_ENV_MARKER=hidden\n", "utf8");
await writeFile(join(workspace, ".env.example"), "SAFE_ENV_EXAMPLE=placeholder\n", "utf8");
await mkdir(join(workspace, ".aws"), { recursive: true });
await writeFile(join(workspace, ".aws", "credentials"), "SENSITIVE_AWS_MARKER=hidden\n", "utf8");
await writeFile(join(workspace, ".npmrc"), "//registry.example.com/:_authToken=hidden\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "NEXT_TASK.md"), "old next task\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "REVIEW.md"), "old review\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await writeFile(join(outside, "secret.txt"), "OUTSIDE_MARKER\n", "utf8");
await writeFile(join(outside, "NEXT_TASK.md"), "outside must remain unchanged\n", "utf8");
await writeFile(join(outside, "hard-linked-secret.txt"), "HARD_LINK_SECRET\n", "utf8");
await writeFile(join(outside, "hard-linked-review.md"), "hard-linked review must remain unchanged\n", "utf8");
await link(join(outside, "hard-linked-secret.txt"), join(workspace, "hard-linked-secret.txt"));
await link(
  join(outside, "hard-linked-review.md"),
  join(hardLinkWriteWorkspace, ".ai-handoff", "REVIEW.md"),
);

const escapePath = join(workspace, "escape");
await symlink(outside, escapePath, process.platform === "win32" ? "junction" : "dir");
await symlink(
  outside,
  join(writeEscapeWorkspace, ".ai-handoff"),
  process.platform === "win32" ? "junction" : "dir",
);

assert.equal(await resolveReviewWorkspaceRoot(workspace, [workspace]), workspace);
assert.equal(await readReviewTextFile(workspace, "inside.txt"), "INSIDE_MARKER\n");
assert.equal(
  await readReviewTextFile(workspace, ".env.example"),
  "SAFE_ENV_EXAMPLE=placeholder\n",
);
await assert.rejects(
  () => readReviewTextFile(workspace, ".env"),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, ".aws/credentials"),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, ".npmrc"),
  ReviewAccessDeniedError,
);

await assert.rejects(
  () => readReviewTextFile(workspace, join(outside, "secret.txt")),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, "../outside/secret.txt"),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, join(workspace, "..", "outside", "secret.txt")),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, "escape/secret.txt"),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readReviewTextFile(workspace, "hard-linked-secret.txt"),
  ReviewAccessDeniedError,
);

const listed = await listReviewDirectory(workspace);
assert.deepEqual(
  listed.find((entry) => entry.path === "escape"),
  { path: "escape", type: "blocked-link" },
);
assert.deepEqual(await searchReviewFiles(workspace, "INSIDE_MARKER"), [
  { path: "inside.txt", line: 1, text: "INSIDE_MARKER" },
]);
assert.deepEqual(await searchReviewFiles(workspace, "OUTSIDE_MARKER"), []);
assert.deepEqual(await searchReviewFiles(workspace, "SENSITIVE_ENV_MARKER"), []);

assert.equal(
  await writeHandoffDocument(workspace, "nextTask", "new next task\n"),
  ".ai-handoff/NEXT_TASK.md",
);
assert.equal(await readFile(join(workspace, ".ai-handoff", "NEXT_TASK.md"), "utf8"), "new next task\n");
assert.equal(await readFile(join(outside, "NEXT_TASK.md"), "utf8"), "outside must remain unchanged\n");

await assert.rejects(
  () => writeHandoffDocument(writeEscapeWorkspace, "nextTask", "must not escape\n"),
  ReviewAccessDeniedError,
);
assert.equal(await readFile(join(outside, "NEXT_TASK.md"), "utf8"), "outside must remain unchanged\n");

await assert.rejects(
  () => writeHandoffDocument(missingTargetWorkspace, "nextTask", "must not create\n"),
  ReviewAccessDeniedError,
);
await assert.rejects(
  () => readFile(join(missingTargetWorkspace, ".ai-handoff", "NEXT_TASK.md"), "utf8"),
);

await assert.rejects(
  () => writeHandoffDocument(hardLinkWriteWorkspace, "review", "must not overwrite hard link\n"),
  ReviewAccessDeniedError,
);
assert.equal(
  await readFile(join(outside, "hard-linked-review.md"), "utf8"),
  "hard-linked review must remain unchanged\n",
);

await assert.rejects(
  () => writeHandoffDocument(workspace, "state", "not-json"),
  /must be valid JSON/,
);
assert.equal(
  await writeHandoffDocument(workspace, "state", '{"phase":"ready_for_codex"}'),
  ".ai-handoff/STATE.json",
);
assert.equal(
  await readFile(join(workspace, ".ai-handoff", "STATE.json"), "utf8"),
  '{\n  "phase": "ready_for_codex"\n}\n',
);

console.log(`review containment fixtures preserved at ${runRoot}`);
