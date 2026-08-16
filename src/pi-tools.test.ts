import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-pi-tools-test-"));

try {
  const context = { cwd: root, root };
  await mkdir(join(root, "nested"));

  const crlfPath = join(root, "nested", "crlf.txt");
  await writeFile(crlfPath, "alpha\r\nbeta\r\n", "utf8");
  const crlf = await readFileTool({ path: crlfPath }, context);
  assert.equal(crlf.isError, undefined);
  assert.equal(crlf.content[0]?.type, "text");
  assert.equal(crlf.content[0]?.text, "alpha\r\nbeta\r\n");

  const pagedPath = join(root, "paged.txt");
  await writeFile(pagedPath, "one\ntwo\nthree\nfour", "utf8");
  const paged = await readFileTool({ path: pagedPath, offset: 2, limit: 2 }, context);
  assert.equal(paged.isError, undefined);
  assert.match(paged.content[0]?.type === "text" ? paged.content[0].text : "", /^two\nthree\n\n\[Showing lines 2-3/);
  assert.match(paged.content[0]?.type === "text" ? paged.content[0].text : "", /offset=4/);

  const utf8BoundaryPath = join(root, "utf8-boundary.txt");
  await writeFile(utf8BoundaryPath, `${"1234567890\n".repeat(5_957)}🙂 boundary\nlast`, "utf8");
  const utf8Boundary = await readFileTool({
    path: utf8BoundaryPath,
    offset: 5_958,
    limit: 1,
  }, context);
  assert.match(
    utf8Boundary.content[0]?.type === "text" ? utf8Boundary.content[0].text : "",
    /^🙂 boundary/,
  );

  const longLinePath = join(root, "long-line.txt");
  await writeFile(longLinePath, "x".repeat(60 * 1024), "utf8");
  const longLine = await readFileTool({ path: longLinePath }, context);
  assert.match(
    longLine.content[0]?.type === "text" ? longLine.content[0].text : "",
    /exceeds 50\.0KB limit/,
  );

  const outOfBounds = await readFileTool({ path: pagedPath, offset: 99 }, context);
  assert.equal(outOfBounds.isError, true);
  assert.match(
    outOfBounds.content[0]?.type === "text" ? outOfBounds.content[0].text : "",
    /Offset 99 is beyond end of file/,
  );

  const exactDefaultLimitPath = join(root, "exact-default-limit.txt");
  const exactDefaultLimitContent = "line\n".repeat(2_000);
  await writeFile(exactDefaultLimitPath, exactDefaultLimitContent, "utf8");
  const exactDefaultLimit = await readFileTool({ path: exactDefaultLimitPath }, context);
  assert.equal(exactDefaultLimit.isError, undefined);
  assert.equal(
    exactDefaultLimit.content[0]?.type === "text" ? exactDefaultLimit.content[0].text : "",
    exactDefaultLimitContent,
  );

  const trailingNewlinePath = join(root, "trailing-newline.txt");
  await writeFile(trailingNewlinePath, "a\n", "utf8");
  const trailingLimited = await readFileTool({ path: trailingNewlinePath, limit: 1 }, context);
  assert.equal(
    trailingLimited.content[0]?.type === "text" ? trailingLimited.content[0].text : "",
    "a\n",
  );
  const trailingOutOfBounds = await readFileTool({ path: trailingNewlinePath, offset: 2 }, context);
  assert.equal(trailingOutOfBounds.isError, true);

  const invalidUtf8Path = join(root, "invalid-utf8.txt");
  await writeFile(invalidUtf8Path, Buffer.alloc(50 * 1024, 0xff));
  const invalidUtf8 = await readFileTool({ path: invalidUtf8Path }, context);
  const invalidUtf8Text = invalidUtf8.content[0]?.type === "text"
    ? invalidUtf8.content[0].text
    : "";
  assert.match(invalidUtf8Text, /exceeds 50\.0KB limit/);
  assert.ok(Buffer.byteLength(invalidUtf8Text, "utf8") < 1024);

  const pngPath = join(root, "image-without-extension");
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const png = await readFileTool({ path: pngPath }, context);
  assert.equal(png.isError, undefined);
  assert.match(
    png.content[0]?.type === "text" ? png.content[0].text : "",
    /^Read image file \[image\/png\]/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
