import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";

const home = homedir();
assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/repo"), resolve(home, "repo"));
assert.equal(expandHomePath("~other/repo"), "~other/repo");
assert.equal(expandHomePath("$HOME/repo"), "$HOME/repo");
assert.equal(isPathInsideRoot(join(home, "repo", "file.txt"), join(home, "repo")), true);
assert.equal(isPathInsideRoot(join(home, "repository"), join(home, "repo")), false);
assert.equal(assertAllowedPath("~/repo/file.txt", [join(home, "repo")]), resolve(home, "repo", "file.txt"));
assert.equal(resolveAllowedPath("file.txt", "/workspace", ["/workspace"]), resolve("/workspace", "file.txt"));
assert.throws(() => assertAllowedPath(join(home, "outside"), [join(home, "repo")]), /outside allowed roots/);

console.log("Root path fixtures passed");
