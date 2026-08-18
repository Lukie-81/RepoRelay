import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { extractZipBuffer, readZipEntries, ZipSafetyError } from "./zip-safe.js";

interface TestZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  cdMethodOverride?: number;
  externalAttrs?: number;
  versionMadeBy?: number;
  crcOverride?: number;
  compressedSizeOverride?: number;
  uncompressedSizeOverride?: number;
}

/** Builds a minimal valid ZIP in memory for tests. */
function buildZip(entries: TestZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const compressed = method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = entry.crcOverride ?? (crc32(entry.data) >>> 0);
    const versionMadeBy = entry.versionMadeBy ?? 0x031e; // Unix host, version 30
    const externalAttrs = entry.externalAttrs ?? ((0o100644 << 16) >>> 0); // regular file
    const compressedSize = entry.compressedSizeOverride ?? compressed.length;
    const uncompressedSize = entry.uncompressedSizeOverride ?? entry.data.length;

    const flags = entry.flags ?? 0;
    const cdMethod = entry.cdMethodOverride ?? method;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(versionMadeBy, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(cdMethod, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuffer.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt32LE(externalAttrs, 38);
    cd.writeUInt32LE(offset, 42);
    centralDirectory.push(cd, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }

  const cdStart = offset;
  const cdSize = centralDirectory.reduce((sum, buffer) => sum + buffer.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...centralDirectory, eocd]);
}

const runRoot = await realpath(await mkdtemp(join(tmpdir(), "reporelay-zip-safe-test-")));
const destDir = join(runRoot, "out");

const goodEntries: TestZipEntry[] = [
  { name: "tunnel-client", data: Buffer.from("binary-1"), method: 0 },
  { name: "cloudflared", data: Buffer.from("binary-2"), method: 8 },
  { name: "LICENSE", data: Buffer.from("license text"), method: 0 },
];
const goodZip = buildZip(goodEntries);
const allowed = new Set(["tunnel-client", "cloudflared", "LICENSE"]);

const names = await extractZipBuffer(goodZip, destDir, { allowedNames: allowed });
assert.deepEqual(names.sort(), ["LICENSE", "cloudflared", "tunnel-client"]);
assert.equal(await readFile(join(destDir, "tunnel-client"), "utf8"), "binary-1");
assert.equal(await readFile(join(destDir, "cloudflared"), "utf8"), "binary-2");

// Reading entries and data directly works for both stored and deflated files.
const entries = readZipEntries(goodZip);
assert.equal(entries.length, 3);
assert.equal(entries.find((entry) => entry.name === "cloudflared")?.method, 8);

// Traversal, absolute paths, and drive letters are rejected.
for (const badName of ["../evil", "a/../../evil", "..\\evil", "/etc/passwd", "C:\\windows\\evil", "C:/windows/evil", "a/..\\evil"]) {
  const badZip = buildZip([{ name: badName, data: Buffer.from("x") }]);
  await assert.rejects(() => extractZipBuffer(badZip, join(runRoot, "traversal")), ZipSafetyError, `expected rejection for ${badName}`);
  assert.equal(readZipEntries(badZip).length, 1);
}

// Unexpected archive paths are rejected (fail closed), including directory entries.
await assert.rejects(
  () => extractZipBuffer(goodZip, join(runRoot, "allowlist"), { allowedNames: new Set(["tunnel-client", "cloudflared"]) }),
  /Unexpected ZIP entry: LICENSE/,
);
await assert.rejects(
  () => extractZipBuffer(buildZip([{ name: "extra.exe", data: Buffer.from("x") }]), join(runRoot, "extra"), { allowedNames: allowed }),
  /Unexpected ZIP entry/,
);

// Symlink entries are rejected.
const symlinkZip = buildZip([{ name: "link", data: Buffer.from("/etc"), externalAttrs: (0o120777 << 16) >>> 0 }]);
await assert.rejects(() => extractZipBuffer(symlinkZip, join(runRoot, "symlink")), /symlink/i);

// Encrypted entries are rejected.
const encryptedZip = buildZip([{ name: "secret", data: Buffer.from("x"), method: 0, flags: 0x1 }]);
await assert.rejects(() => extractZipBuffer(encryptedZip, join(runRoot, "encrypted")), /Encrypted/);

// Unsupported compression methods are rejected.
const weirdMethodZip = buildZip([{ name: "weird", data: Buffer.from("x"), method: 0, cdMethodOverride: 12 }]);
await assert.rejects(() => extractZipBuffer(weirdMethodZip, join(runRoot, "method")), /Unsupported ZIP compression method/);

// CRC mismatch is rejected.
const corruptCrcZip = buildZip([{ name: "tunnel-client", data: Buffer.from("binary"), method: 0, crcOverride: 0xdeadbeef }]);
await assert.rejects(() => extractZipBuffer(corruptCrcZip, join(runRoot, "crc")), /CRC mismatch/);

// Size mismatch is rejected.
const sizeMismatchZip = buildZip([{ name: "tunnel-client", data: Buffer.from("binary"), method: 0, compressedSizeOverride: 3 }]);
await assert.rejects(() => extractZipBuffer(sizeMismatchZip, join(runRoot, "size")), /size mismatch/);

// ZIP64 markers are rejected.
const zip64Zip = buildZip([{ name: "big", data: Buffer.from("x"), method: 0, uncompressedSizeOverride: 0xffffffff }]);
await assert.rejects(() => extractZipBuffer(zip64Zip, join(runRoot, "zip64")), /ZIP64/);

// Not a ZIP at all is rejected.
await assert.rejects(() => extractZipBuffer(Buffer.from("not a zip file at all"), join(runRoot, "notzip")), ZipSafetyError);
await assert.rejects(() => extractZipBuffer(Buffer.alloc(10), join(runRoot, "tiny")), ZipSafetyError);

console.log(`ZIP safety fixtures preserved at ${runRoot}`);
