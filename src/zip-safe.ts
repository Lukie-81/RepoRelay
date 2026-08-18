import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_MARKER = 0xffffffff;

export class ZipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipSafetyError";
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
  versionMadeBy: number;
}

/** Locates the end-of-central-directory record offset, or throws. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const maxScan = Math.min(buffer.length, 22 + 65_535);
  const scanStart = Math.max(0, buffer.length - maxScan);
  let offset = buffer.length - 22;
  while (offset >= scanStart) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
    offset -= 1;
  }
  throw new ZipSafetyError("Not a supported ZIP archive (missing end-of-central-directory record).");
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new ZipSafetyError("Not a supported ZIP archive (too small).");
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = eocd === -1 ? 0 : buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  if (cdOffset === ZIP64_MARKER || cdSize === ZIP64_MARKER) {
    throw new ZipSafetyError("ZIP64 archives are not supported.");
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new ZipSafetyError("ZIP central directory exceeds archive bounds.");
  }

  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CD) {
      throw new ZipSafetyError("Invalid ZIP central-directory entry.");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw new ZipSafetyError("ZIP central-directory entry exceeds archive bounds.");
    }
    entries.push({
      name: buffer.toString("utf8", offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      flags: buffer.readUInt16LE(offset + 8),
      crc: buffer.readUInt32LE(offset + 16),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
      externalAttrs: buffer.readUInt32LE(offset + 38),
      versionMadeBy: buffer.readUInt16LE(offset + 4),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Rejects absolute paths, drive letters, and any `..` traversal segment. */
export function assertSafeZipEntryName(name: string): string {
  if (!name || name.includes("\0")) throw new ZipSafetyError(`ZIP entry has an invalid name: ${JSON.stringify(name)}`);
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/")) throw new ZipSafetyError(`ZIP entry has an absolute path: ${name}`);
  if (/^[a-zA-Z]:/.test(normalized)) throw new ZipSafetyError(`ZIP entry has an absolute drive path: ${name}`);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ZipSafetyError(`ZIP entry attempts path traversal: ${name}`);
  }
  return normalized;
}

export function isZipSymlink(entry: ZipEntry): boolean {
  const hostOs = (entry.versionMadeBy >>> 8) & 0xff;
  if (hostOs !== 3) return false; // only Unix mode bits are meaningful
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

export function readZipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipSafetyError(`Encrypted ZIP entries are not supported: ${entry.name}`);
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new ZipSafetyError(`Unsupported ZIP compression method ${entry.method}: ${entry.name}`);
  }
  if (
    entry.compressedSize === ZIP64_MARKER
    || entry.uncompressedSize === ZIP64_MARKER
    || entry.localHeaderOffset === ZIP64_MARKER
  ) {
    throw new ZipSafetyError("ZIP64 archives are not supported.");
  }
  if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== SIG_LOCAL) {
    throw new ZipSafetyError(`Invalid ZIP local file header: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new ZipSafetyError(`ZIP entry data exceeds archive bounds: ${entry.name}`);

  // Use central-directory sizes (correct even when the data-descriptor flag is set).
  const compressed = buffer.subarray(dataStart, dataEnd);
  let output: Buffer;
  if (entry.method === METHOD_STORE) {
    output = Buffer.from(compressed);
  } else {
    output = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  }
  if (output.length !== entry.uncompressedSize) {
    throw new ZipSafetyError(`ZIP entry size mismatch: ${entry.name}`);
  }
  if ((crc32(output) >>> 0) !== (entry.crc >>> 0)) {
    throw new ZipSafetyError(`ZIP entry CRC mismatch: ${entry.name}`);
  }
  return output;
}

export interface SafeExtractOptions {
  /** If provided, only these exact entry names may be extracted; anything else fails closed. */
  allowedNames?: ReadonlySet<string>;
  /** Entry names that must receive executable permissions on Unix-like systems. */
  executableNames?: ReadonlySet<string>;
  onEntry?: (name: string) => void;
}

/**
 * Extracts a verified in-memory ZIP archive into `destDir`, fail-closed.
 *
 * - rejects absolute paths, drive letters, and `..` traversal;
 * - rejects symlink/reparse entries and encrypted or unsupported entries;
 * - only extracts entries present in `allowedNames` (when provided);
 * - verifies per-entry size and CRC32 before writing;
 * - writes into `destDir` only (defense-in-depth containment check).
 */
export async function extractZipBuffer(zipBuffer: Buffer, destDir: string, options: SafeExtractOptions = {}): Promise<string[]> {
  const entries = readZipEntries(zipBuffer);
  const extracted: string[] = [];
  const resolvedDest = resolve(destDir);
  for (const entry of entries) {
    const name = assertSafeZipEntryName(entry.name);
    if (name.endsWith("/")) {
      if (options.allowedNames && !options.allowedNames.has(name)) {
        throw new ZipSafetyError(`Unexpected ZIP directory entry: ${name}`);
      }
      continue;
    }
    if (options.allowedNames && !options.allowedNames.has(name)) {
      throw new ZipSafetyError(`Unexpected ZIP entry: ${name}`);
    }
    if (isZipSymlink(entry)) throw new ZipSafetyError(`ZIP symlink entries are not allowed: ${name}`);
    const target = resolve(resolvedDest, ...name.split("/"));
    const relationship = relative(resolvedDest, target);
    if (relationship === "" || isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new ZipSafetyError(`ZIP entry escapes the destination directory: ${name}`);
    }
    const mode = options.executableNames?.has(name) ? 0o755 : 0o644;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, readZipEntryData(zipBuffer, entry), { mode });
    extracted.push(name);
    options.onEntry?.(name);
  }
  return extracted;
}
