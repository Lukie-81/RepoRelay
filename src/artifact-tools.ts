import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ArtifactError } from "./artifact-error.js";
import type { ServerConfig } from "./config.js";
import {
  describeIncomingArtifactValue,
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const BINARY_WRITE_ANNOTATIONS = {
  ...ARTIFACT_WRITE_ANNOTATIONS,
  openWorldHint: false,
};
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW;
const PARTIAL_PREFIX = ".devspace-download-";
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_PARTIAL_CLEANUP = 32;
const MCP_JSON_ENVELOPE_BYTES = 1024 * 1024;
const MAX_INLINE_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_DATA_URL_HEADER_CHARACTERS = 8 * 1024;
const MAX_BASE64_WHITESPACE_CHARACTERS = 64 * 1024;
const WINDOWS_PLATFORM = "win32";
const WINDOWS_ANCHOR_PATH = Symbol("devspaceArtifactAnchorPath");
const ARTIFACT_DOWNLOAD_PLATFORMS = new Set<NodeJS.Platform>(["linux", WINDOWS_PLATFORM]);

const openAIFileReferenceInputSchema = z.strictObject({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

export interface ArtifactToolRegistrationOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export interface DownloadIncomingArtifactInput {
  file: unknown;
  workspaceId: string;
  path: string;
}

export interface DownloadIncomingArtifactResult {
  path: string;
  size: number;
  sha256: string;
}

export function isArtifactDownloadSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ARTIFACT_DOWNLOAD_PLATFORMS.has(platform);
}

export function shouldRegisterArtifactTools(
  artifactsEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return artifactsEnabled && isArtifactDownloadSupportedPlatform(platform);
}

interface ArtifactDirectoryHandle {
  fd?: number;
  [WINDOWS_ANCHOR_PATH]?: string;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

interface SecureDestinationDirectory {
  handle: ArtifactDirectoryHandle;
  anchorPath: string;
  close(): Promise<void>;
}

interface ArtifactDestination {
  path: string;
  parentParts: string[];
  name: string;
}

export function registerArtifactTools(
  server: McpServer,
  {
    config,
    workspaces,
    incomingArtifactAdapters = [],
  }: ArtifactToolRegistrationOptions,
): void {
  const incomingRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);

  registerAppTool(
    server,
    "download_artifact",
    {
      title: "Download attached or generated file",
      description:
        "Stream one MCP-host-provided native file to a requested relative path inside an already-open workspace. Existing destinations, arbitrary URLs, absolute paths, traversal, symlinked parents, local source paths, and malformed file objects are rejected.",
      inputSchema: {
        file: openAIFileReferenceInputSchema.describe(
          "Native file value authorized and supplied by the MCP host.",
        ),
        workspaceId: z.string().min(1).describe(
          "Workspace identifier returned by open_workspace.",
        ),
        path: z.string().min(1).describe(
          "Relative destination path inside the selected workspace. The destination must not already exist.",
        ),
      },
      outputSchema: {
        path: z.string(),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: ARTIFACT_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, input, async () => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const downloaded = await downloadIncomingArtifact({
        registry: incomingRegistry,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        maxFileBytes: config.artifactMaxFileBytes,
        file: input.file,
        path: input.path,
      });
      return {
        publicResult: { path: downloaded.path },
        logResult: downloaded,
      };
    }),
  );

  registerAppTool(
    server,
    "write_binary",
    {
      title: "Write Base64 binary file",
      description:
        "Decode one complete Base64 string or data URL and write the original bytes to a requested relative path inside an already-open workspace. Use this when native file parameters are unavailable. Existing destinations, absolute paths, traversal, symlinked parents, and oversized files are rejected.",
      inputSchema: {
        workspaceId: z.string().min(1).describe(
          "Workspace identifier returned by open_workspace.",
        ),
        path: z.string().min(1).describe(
          "Relative destination path inside the selected workspace. The destination must not already exist.",
        ),
        contentBase64: z.string().min(1).describe(
          "Complete raw Base64 payload or a data URL containing a ;base64 payload.",
        ),
      },
      outputSchema: {
        path: z.string(),
      },
      _meta: {},
      annotations: BINARY_WRITE_ANNOTATIONS,
    },
    async (input) => executeArtifactTool(config, input, async () => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const registry = new IncomingArtifactAdapterRegistry([{
        id: "inline-base64",
        canHandle: () => true,
        async open() {
          const decoded = openBase64ArtifactStream(
            input.contentBase64,
            inlineArtifactMaxFileBytes(config.artifactMaxFileBytes),
          );
          return {
            name: "inline-base64.bin",
            size: decoded.size,
            stream: decoded.stream,
          };
        },
      }]);
      const downloaded = await downloadIncomingArtifact({
        registry,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        maxFileBytes: config.artifactMaxFileBytes,
        file: { inlineBase64: true },
        path: input.path,
      });
      return {
        publicResult: { path: downloaded.path },
        logResult: downloaded,
      };
    }, {
      tool: "write_binary",
      logFields: {
        workspaceId: input.workspaceId,
        path: input.path,
        encoding: "base64",
      },
    }),
  );
}

export function decodeBase64Artifact(value: string, maxFileBytes: number): Buffer {
  const analysis = analyzeBase64Artifact(value, maxFileBytes);
  const bytes = Buffer.from(analysis.encoded, "base64");
  if (bytes.length !== analysis.size) {
    throw new ArtifactError(
      "artifact_base64_invalid",
      "Binary content was not valid Base64.",
    );
  }
  return bytes;
}

export function openBase64ArtifactStream(
  value: string,
  maxFileBytes: number,
): { size: number; stream: Readable } {
  const analysis = analyzeBase64Artifact(value, maxFileBytes);
  return {
    size: analysis.size,
    stream: Readable.from(iterateBase64ArtifactChunks(analysis.encoded)),
  };
}

function analyzeBase64Artifact(
  value: string,
  maxFileBytes: number,
): { size: number; encoded: string } {
  let start = 0;
  let end = value.length;
  while (start < end && isWhitespace(value[start] ?? "")) start++;
  while (end > start && isWhitespace(value[end - 1] ?? "")) end--;
  if (start === end) {
    throw new ArtifactError(
      "artifact_base64_invalid",
      "Binary content must be a non-empty Base64 string or data URL.",
    );
  }

  let payloadStart = start;
  if (value.slice(start, Math.min(end, start + 5)).toLowerCase() === "data:") {
    const comma = value.indexOf(",", start);
    if (comma < start || comma >= end) {
      throw new ArtifactError(
        "artifact_base64_invalid",
        "Binary data URL must use Base64 encoding.",
      );
    }
    const header = value.slice(start, comma + 1);
    if (
      header.length > MAX_DATA_URL_HEADER_CHARACTERS
      || !/^data:[^,]*;base64,$/iu.test(header)
    ) {
      throw new ArtifactError(
        "artifact_base64_invalid",
        "Binary data URL must use Base64 encoding.",
      );
    }
    payloadStart = comma + 1;
  }

  const rawPayload = value.slice(payloadStart, end);
  const encoded = rawPayload.replace(/\s+/gu, "");
  if (rawPayload.length - encoded.length > MAX_BASE64_WHITESPACE_CHARACTERS) {
    throwInvalidBase64();
  }
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throwInvalidBase64();
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const dataCharacters = encoded.length - padding;
  const encodedLength = encoded.length;
  if (padding > 0 && encodedLength % 4 !== 0) throwInvalidBase64();
  const remainder = dataCharacters % 4;
  if (remainder === 1) throwInvalidBase64();

  const finalDataCharacter = encoded[dataCharacters - 1] ?? "";
  const alphabetIndex = base64AlphabetIndex(finalDataCharacter);
  if ((padding === 2 || (padding === 0 && remainder === 2)) && (alphabetIndex & 0x0f) !== 0) {
    throwInvalidBase64();
  }
  if ((padding === 1 || (padding === 0 && remainder === 3)) && (alphabetIndex & 0x03) !== 0) {
    throwInvalidBase64();
  }

  const size = Math.floor(dataCharacters * 3 / 4);
  if (size > maxFileBytes) {
    throw new ArtifactError(
      "artifact_file_too_large",
      "Binary content exceeds the configured per-file limit.",
    );
  }
  return { size, encoded };
}

function* iterateBase64ArtifactChunks(
  encoded: string,
): Generator<Buffer> {
  const chunkCharacters = 64 * 1024;
  for (let start = 0; start < encoded.length; start += chunkCharacters) {
    yield Buffer.from(encoded.slice(start, start + chunkCharacters), "base64");
  }
}

function isWhitespace(value: string): boolean {
  return /^\s$/u.test(value);
}

function throwInvalidBase64(): never {
  throw new ArtifactError(
    "artifact_base64_invalid",
    "Binary content was not valid Base64.",
  );
}

export function artifactJsonBodyLimit(maxFileBytes: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(maxFileBytes * 4 / 3) + MCP_JSON_ENVELOPE_BYTES,
  );
}

export function inlineArtifactMaxFileBytes(configuredMaxFileBytes: number): number {
  return Math.min(configuredMaxFileBytes, MAX_INLINE_BINARY_BYTES);
}

function base64AlphabetIndex(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === "+" ? 62 : 63;
}

/**
 * Stream a trusted native file directly into one already-open workspace.
 *
 * Bytes are written to an exclusive partial beside the requested destination,
 * hashed and size-checked, fsynced, and only then published without overwriting
 * the requested workspace path. No project-level staging directory is created.
 */
export async function downloadIncomingArtifact({
  registry,
  workspaceId,
  workspaceRoot,
  maxFileBytes,
  file,
  path,
  publishLink = link,
}: {
  registry: IncomingArtifactAdapterRegistry;
  workspaceId: string;
  workspaceRoot: string;
  maxFileBytes: number;
  file: unknown;
  path: string;
  publishLink?: typeof link;
}): Promise<DownloadIncomingArtifactResult> {
  if (!isArtifactDownloadSupportedPlatform()) {
    throw new ArtifactError(
      "artifact_platform_unsupported",
      "Native file download requires descriptor-anchored directory operations on this platform.",
    );
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactError(
      "artifact_limit_invalid",
      "Artifact file-size limit must be a positive integer.",
    );
  }
  if (!workspaceId) {
    throw new ArtifactError(
      "artifact_workspace_invalid",
      "A selected workspace is required for native file download.",
    );
  }

  const destination = normalizeArtifactDestination(path);
  const opened = await registry.open(file);
  let workspaceHandle: ArtifactDirectoryHandle | undefined;
  let destinationDirectory: SecureDestinationDirectory | undefined;
  let partialPath: string | undefined;
  let handle: FileHandle | undefined;

  try {
    if (opened.size !== undefined && opened.size > maxFileBytes) {
      throw new ArtifactError(
        "artifact_file_too_large",
        "Native file exceeds the configured per-file limit.",
      );
    }

    workspaceHandle = await openDirectoryNoFollow(
      workspaceRoot,
      "artifact_workspace_unsafe",
      "Selected workspace root is not a real directory.",
      true,
    );
    destinationDirectory = await prepareDestinationDirectory(
      workspaceHandle,
      destination.parentParts,
    );
    await cleanupStalePartials(destinationDirectory);
    await assertArtifactDirectoriesReady(workspaceHandle, destinationDirectory);

    partialPath = join(
      destinationDirectory.anchorPath,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    handle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );

    const hash = createHash("sha256");
    let size = 0;
    for await (const value of opened.stream) {
      const chunk = incomingStreamChunk(value);
      if (size + chunk.length > maxFileBytes) {
        throw new ArtifactError(
          "artifact_file_too_large",
          "Native file exceeds the configured per-file limit.",
        );
      }
      await writeAll(handle, chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }

    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactError(
        "artifact_file_size_mismatch",
        "Native file metadata did not match the downloaded content.",
      );
    }

    await handle.sync();
    const writtenEntry = await handle.stat();
    if (!writtenEntry.isFile() || writtenEntry.size !== size) {
      throw new ArtifactError(
        "artifact_write_integrity_failed",
        "Native file could not be verified before publication.",
      );
    }

    const partialEntry = await lstat(partialPath);
    if (
      partialEntry.isSymbolicLink()
      || !partialEntry.isFile()
      || partialEntry.dev !== writtenEntry.dev
      || partialEntry.ino !== writtenEntry.ino
      || partialEntry.size !== writtenEntry.size
    ) {
      throw new ArtifactError(
        "artifact_partial_unsafe",
        "Native file partial changed before publication.",
      );
    }

    await assertArtifactDirectoriesReady(workspaceHandle, destinationDirectory);
    await publishDestination(
      destinationDirectory,
      partialPath,
      destination.name,
      writtenEntry,
      handle,
      publishLink,
    );
    await unlink(partialPath).catch(() => undefined);
    partialPath = undefined;

    return {
      path: destination.path,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    opened.stream.destroy();
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    await destinationDirectory?.close().catch(() => undefined);
    await workspaceHandle?.close().catch(() => undefined);
  }
}

export function artifactToolLogFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    fileProvided: input.file !== undefined,
    fileReferenceShape: describeIncomingArtifactValue(input.file),
    downloadUrlHostname: incomingFileDownloadHostname(input.file),
    workspaceId: input.workspaceId,
    path: input.path,
  };
}

async function executeArtifactTool(
  config: ServerConfig,
  input: Record<string, unknown>,
  operation: () => Promise<{
    publicResult: { path: string };
    logResult: DownloadIncomingArtifactResult;
  }>,
  {
    tool = "download_artifact",
    logFields = artifactToolLogFields(input),
  }: {
    tool?: string;
    logFields?: Record<string, unknown>;
  } = {},
) {
  const startedAt = performance.now();
  try {
    const { publicResult, logResult } = await operation();
    if (config.logging.toolCalls) {
      logEvent(config.logging, "info", "artifact_tool_call", {
        tool,
        ...logFields,
        path: logResult.path,
        size: logResult.size,
        sha256: logResult.sha256,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return artifactToolResponse(publicResult);
  } catch (error) {
    if (config.logging.toolCalls) {
      logEvent(config.logging, "warn", "artifact_tool_call", {
        tool,
        ...logFields,
        success: false,
        errorCode: error instanceof ArtifactError ? error.code : "internal_error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    throw error;
  }
}

function artifactToolResponse(result: { path: string }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function openDirectoryNoFollow(
  path: string,
  code: string,
  message: string,
  allowResolvedAlias = false,
): Promise<ArtifactDirectoryHandle> {
  if (process.platform === WINDOWS_PLATFORM) {
    try {
      const resolvedPath = await assertWindowsRealDirectoryPath(
        path,
        code,
        message,
        allowResolvedAlias,
      );
      const handle = createWindowsDirectoryHandle(resolvedPath);
      await assertDirectoryHandle(handle);
      return handle;
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError(code, message);
    }
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, DIRECTORY_FLAGS);
    await assertDirectoryHandle(handle);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError(code, message);
  }
}

async function assertDirectoryHandle(handle: ArtifactDirectoryHandle): Promise<void> {
  const windowsPath = handle[WINDOWS_ANCHOR_PATH];
  if (process.platform === WINDOWS_PLATFORM && windowsPath) {
    await assertWindowsRealDirectoryPath(
      windowsPath,
      "artifact_directory_unsafe",
      "Artifact destination parent is not a real directory.",
    );
  }
  const entry = await handle.stat();
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ArtifactError(
      "artifact_directory_unsafe",
      "Artifact destination parent is not a directory.",
    );
  }
}

async function assertArtifactDirectoriesReady(
  workspaceHandle: ArtifactDirectoryHandle,
  destinationDirectory: SecureDestinationDirectory,
): Promise<void> {
  await assertDirectoryHandle(workspaceHandle);
  await assertDirectoryHandle(destinationDirectory.handle);
}

function createWindowsDirectoryHandle(path: string): ArtifactDirectoryHandle {
  return {
    [WINDOWS_ANCHOR_PATH]: path,
    async stat() {
      return lstat(path);
    },
    async close() {},
  };
}

async function assertWindowsRealDirectoryPath(
  path: string,
  code: string,
  message: string,
  allowResolvedAlias = false,
): Promise<string> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch {
    throw new ArtifactError(code, message);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ArtifactError(code, message);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch {
    throw new ArtifactError(code, message);
  }
  if (!allowResolvedAlias && !sameWindowsPath(path, resolvedPath)) {
    throw new ArtifactError(code, message);
  }

  let resolvedEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    resolvedEntry = await lstat(resolvedPath);
  } catch {
    throw new ArtifactError(code, message);
  }
  if (!resolvedEntry.isDirectory() || resolvedEntry.isSymbolicLink()) {
    throw new ArtifactError(code, message);
  }
  return resolvedPath;
}

function sameWindowsPath(left: string, right: string): boolean {
  return canonicalWindowsPath(left) === canonicalWindowsPath(right);
}

function canonicalWindowsPath(value: string): string {
  let candidate = value;
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate.startsWith("\\\\?\\unc\\")) {
    candidate = `\\\\${candidate.slice(8)}`;
  } else if (candidate.startsWith("\\\\?\\")) {
    candidate = candidate.slice(4);
  }
  candidate = normalize(resolve(candidate));
  if (candidate.length > 3) candidate = candidate.replace(/[\\/]$/u, "");
  return candidate.toLowerCase();
}

function descriptorDirectoryPath(handle: ArtifactDirectoryHandle): string {
  if (process.platform === WINDOWS_PLATFORM) {
    const anchorPath = handle[WINDOWS_ANCHOR_PATH];
    if (anchorPath) return anchorPath;
    throw new ArtifactError(
      "artifact_platform_unsupported",
      "Native file download could not establish a Windows directory anchor.",
    );
  }
  if (process.platform === "linux" && typeof handle.fd === "number") {
    return `/proc/self/fd/${handle.fd}`;
  }
  throw new ArtifactError(
    "artifact_platform_unsupported",
    "Native file download requires descriptor-anchored directory operations on this platform.",
  );
}

function normalizeArtifactDestination(value: string): ArtifactDestination {
  const rawParts = value.split(/[\\/]/u);
  if (
    !value
    || value.includes("\u0000")
    || isAbsolute(value)
    || /[\\/]$/u.test(value)
    || rawParts.includes("..")
  ) {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must be a non-empty relative file path inside the workspace.",
    );
  }

  const normalized = normalize(value);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must stay inside the selected workspace.",
    );
  }

  const parts = normalized.split(sep);
  const name = parts.at(-1);
  if (!name || name === "." || name === "..") {
    throw new ArtifactError(
      "artifact_destination_invalid",
      "Artifact destination must name a file inside the selected workspace.",
    );
  }

  return {
    path: normalized,
    parentParts: parts.slice(0, -1),
    name,
  };
}

async function prepareDestinationDirectory(
  rootHandle: ArtifactDirectoryHandle,
  parentParts: readonly string[],
): Promise<SecureDestinationDirectory> {
  const openedHandles: ArtifactDirectoryHandle[] = [];
  let parentHandle = rootHandle;
  let parentAnchor = descriptorDirectoryPath(rootHandle);

  try {
    for (const part of parentParts) {
      const child = await ensureWorkspaceChildDirectory(
        parentHandle,
        parentAnchor,
        part,
      );
      openedHandles.push(child);
      parentHandle = child;
      parentAnchor = descriptorDirectoryPath(child);
    }

    return {
      handle: parentHandle,
      anchorPath: parentAnchor,
      async close() {
        for (const handle of openedHandles.reverse()) {
          await handle.close().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    for (const handle of openedHandles.reverse()) {
      await handle.close().catch(() => undefined);
    }
    throw error;
  }
}

async function ensureWorkspaceChildDirectory(
  parentHandle: ArtifactDirectoryHandle,
  parentAnchor: string,
  name: string,
): Promise<ArtifactDirectoryHandle> {
  await assertDirectoryHandle(parentHandle);
  const path = join(parentAnchor, name);
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }

  return openDirectoryNoFollow(
    path,
    "artifact_destination_parent_unsafe",
    "Artifact destination parent must be a real directory inside the workspace.",
  );
}

async function publishDestination(
  directory: SecureDestinationDirectory,
  partialPath: string,
  filename: string,
  writtenEntry: Awaited<ReturnType<FileHandle["stat"]>>,
  handle: FileHandle,
  publishLink: typeof link,
): Promise<void> {
  await assertDirectoryHandle(directory.handle);
  const candidate = join(directory.anchorPath, filename);
  try {
    await publishLink(partialPath, candidate);
    assertPublishedArtifactEntry(await lstat(candidate), writtenEntry);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ArtifactError(
        "artifact_destination_exists",
        "Artifact destination already exists.",
      );
    }
    // Once the destination path exists, never unlink it during failure cleanup.
    // Another process may have replaced that path after publication, and a
    // path-based verification followed by unlink would introduce another race.
    throw error;
  }
}

function assertPublishedArtifactEntry(
  entry: Awaited<ReturnType<typeof lstat>>,
  writtenEntry: Awaited<ReturnType<FileHandle["stat"]>>,
): void {
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || entry.dev !== writtenEntry.dev
    || entry.ino !== writtenEntry.ino
    || entry.size !== writtenEntry.size
  ) {
    throw new ArtifactError(
      "artifact_destination_publish_failed",
      "Published artifact did not match the verified download.",
    );
  }
}

async function cleanupStalePartials(
  directory: SecureDestinationDirectory,
): Promise<void> {
  await assertDirectoryHandle(directory.handle);
  const entries = await readdir(directory.anchorPath, { withFileTypes: true });
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
  for (const entry of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;
    if (
      !entry.name.startsWith(PARTIAL_PREFIX)
      || !entry.name.endsWith(PARTIAL_SUFFIX)
    ) continue;
    inspected += 1;

    const path = join(directory.anchorPath, entry.name);
    const metadata = await lstatOrUndefined(path);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await unlink(path).catch(() => undefined);
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ArtifactError(
        "artifact_short_write",
        "Native file was not fully written.",
      );
    }
    offset += bytesWritten;
  }
}

function incomingFileDownloadHostname(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const rawUrl = (value as Record<string, unknown>).download_url;
  if (typeof rawUrl !== "string") return undefined;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.length > 0 && hostname.length <= 253 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function incomingStreamChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ArtifactError(
    "invalid_incoming_artifact_chunk",
    "Incoming artifact stream yielded a value that is not bytes or text.",
  );
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
