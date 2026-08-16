import assert from "node:assert/strict";
import {
  INLINE_PATCH_MAX_BYTES,
  contentLineCount,
  mcpBodyParserErrorStatus,
  newFilePatch,
} from "./server.js";

assert.equal(contentLineCount(""), 0);
assert.equal(contentLineCount("one"), 1);
assert.equal(contentLineCount("one\n"), 1);
assert.equal(contentLineCount("one\ntwo\n"), 2);

const smallPatch = newFilePatch("small.txt", "one\ntwo\n");
assert.ok(smallPatch);
assert.match(smallPatch, /@@ -0,0 \+1,2 @@/);
assert.ok(Buffer.byteLength(smallPatch, "utf8") <= INLINE_PATCH_MAX_BYTES);

const largeContent = "0123456789abcdef\n".repeat(20_000);
assert.equal(newFilePatch("large.txt", largeContent), undefined);

const escapeHeavyContent = "\\\"\u0000\n".repeat(30_000);
assert.equal(newFilePatch("escaped.txt", escapeHeavyContent), undefined);

assert.equal(mcpBodyParserErrorStatus({ type: "entity.too.large" }), 413);
assert.equal(mcpBodyParserErrorStatus({ type: "entity.parse.failed" }), 400);
assert.equal(mcpBodyParserErrorStatus(new Error("other")), undefined);
