import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listReviewDirectory,
  readReviewTextFile,
  ReviewAccessDeniedError,
  resolveReviewWorkspaceRoot,
  searchReviewFiles,
  writeHandoffDocument,
} from "./review-files.js";

const runRoot = await realpath(await mkdtemp(join(tmpdir(), "reporelay-review-files-test-")));
const workspace = join(runRoot, "workspace");
const outside = join(runRoot, "outside");
await mkdir(join(workspace, ".ai-handoff"), { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(join(workspace, "inside.txt"), "inside marker\n", "utf8");
await writeFile(join(workspace, ".env"), "environment secret\n", "utf8");
await mkdir(join(workspace, ".git"), { recursive: true });
await writeFile(join(workspace, ".git", "config"), "[remote \"origin\"]\n", "utf8");
await writeFile(join(outside, "outside.txt"), "outside marker\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "REVIEW.md"), "review\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "RESULT.md"), "implementer result\n", "utf8");
await writeFile(join(workspace, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
await link(join(outside, "outside.txt"), join(workspace, "hard-link.txt"));

assert.equal(await readReviewTextFile(workspace, "inside.txt"), "inside marker\n");
await assert.rejects(() => readReviewTextFile(workspace, "../outside/outside.txt"), ReviewAccessDeniedError);
await assert.rejects(() => readReviewTextFile(workspace, "escape/outside.txt"), ReviewAccessDeniedError);
await assert.rejects(() => readReviewTextFile(workspace, "hard-link.txt"), ReviewAccessDeniedError);
await assert.rejects(() => readReviewTextFile(workspace, ".env"), ReviewAccessDeniedError);
await assert.rejects(() => readReviewTextFile(workspace, ".env."), ReviewAccessDeniedError);
await assert.rejects(() => readReviewTextFile(workspace, ".git./config"), ReviewAccessDeniedError);
await assert.rejects(
  () => resolveReviewWorkspaceRoot(join(workspace, ".git"), [workspace]),
  ReviewAccessDeniedError,
);

const listed = await listReviewDirectory(workspace, ".");
assert.equal(listed.find((entry) => entry.path === "escape")?.type, "blocked-link");
assert.equal((await searchReviewFiles(workspace, "outside marker")).length, 0);
assert.equal((await searchReviewFiles(workspace, "inside marker"))[0]?.path, "inside.txt");

assert.equal(await writeHandoffDocument(workspace, "review", "updated review\n"), ".ai-handoff/REVIEW.md");
assert.equal(await readFile(join(workspace, ".ai-handoff", "REVIEW.md"), "utf8"), "updated review\n");
assert.equal(await writeHandoffDocument(workspace, "state", '{"phase":"ready_for_review"}'), ".ai-handoff/STATE.json");
assert.equal(await readFile(join(workspace, ".ai-handoff", "STATE.json"), "utf8"), '{\n  "phase": "ready_for_review"\n}\n');
assert.equal(await readFile(join(workspace, ".ai-handoff", "RESULT.md"), "utf8"), "implementer result\n");
const hardlinkWorkspace = join(runRoot, "hardlink-workspace");
await mkdir(join(hardlinkWorkspace, ".ai-handoff"), { recursive: true });
await link(join(outside, "outside.txt"), join(hardlinkWorkspace, ".ai-handoff", "NEXT_TASK.md"));
await assert.rejects(() => writeHandoffDocument(hardlinkWorkspace, "nextTask", "must not overwrite hard link"), ReviewAccessDeniedError);
const missingWorkspace = join(runRoot, "missing-target-workspace");
await mkdir(join(missingWorkspace, ".ai-handoff"), { recursive: true });
await assert.rejects(() => writeHandoffDocument(missingWorkspace, "review", "must not create a target"), ReviewAccessDeniedError);

console.log(`Review containment fixtures preserved at ${runRoot}`);
