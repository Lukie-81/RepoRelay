import { open, lstat, realpath, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHomePath } from "./roots.js";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_HANDOFF_MARKDOWN_BYTES = 1024 * 1024;
const MAX_HANDOFF_STATE_BYTES = 64 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_RESULT_LINE_CHARACTERS = 500;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

const BLOCKED_REVIEW_PATH_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".ssh",
  "secrets",
]);

const BLOCKED_REVIEW_FILENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

const BLOCKED_REVIEW_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".kdbx",
  ".p12",
  ".pem",
  ".pfx",
  ".ppk",
]);

const HANDOFF_PATHS = {
  nextTask: ".ai-handoff/NEXT_TASK.md",
  review: ".ai-handoff/REVIEW.md",
  state: ".ai-handoff/STATE.json",
} as const;

export type HandoffDocument = keyof typeof HANDOFF_PATHS;

export class ReviewAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewAccessDeniedError";
  }
}

export interface ReviewDirectoryEntry {
  path: string;
  type: "file" | "directory" | "blocked-link" | "other";
}

export interface ReviewSearchMatch {
  path: string;
  line: number;
  text: string;
}

interface SafeExistingPath {
  absolutePath: string;
  relativePath: string;
  stats: Awaited<ReturnType<typeof lstat>>;
}

export async function resolveReviewWorkspaceRoot(
  inputPath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const requestedPath = resolve(expandHomePath(inputPath));

  for (const configuredRoot of allowedRoots) {
    const lexicalRoot = resolve(expandHomePath(configuredRoot));
    if (!isPathInside(requestedPath, lexicalRoot)) continue;

    const canonicalAllowedRoot = await canonicalDirectory(lexicalRoot, "Approved root");
    await assertNoRedirectingSegments(lexicalRoot, requestedPath, canonicalAllowedRoot);
    const canonicalRequested = await canonicalDirectory(requestedPath, "Workspace root");
    if (!isPathInside(canonicalRequested, canonicalAllowedRoot)) {
      throw new ReviewAccessDeniedError("Workspace resolves outside the canonical approved root.");
    }
    assertReviewPathNotSensitive(relative(canonicalAllowedRoot, canonicalRequested));

    return canonicalRequested;
  }

  throw new ReviewAccessDeniedError("Workspace is outside the approved roots.");
}

export async function readReviewTextFile(workspaceRoot: string, inputPath: string): Promise<string> {
  const safePath = await resolveReviewExistingPath(workspaceRoot, inputPath, "file");
  const handle = await open(safePath.absolutePath, "r");
  try {
    await verifyOpenHandle(workspaceRoot, inputPath, safePath, handle);
    const stats = await handle.stat();
    if (stats.size > MAX_READ_BYTES) {
      throw new Error(`File exceeds the ${MAX_READ_BYTES}-byte review limit.`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function listReviewDirectory(
  workspaceRoot: string,
  inputPath = ".",
): Promise<ReviewDirectoryEntry[]> {
  const safeDirectory = await resolveReviewExistingPath(workspaceRoot, inputPath, "directory");
  const entries = await readdir(safeDirectory.absolutePath, { withFileTypes: true });
  const output: ReviewDirectoryEntry[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelativePath = toWorkspacePath(join(safeDirectory.relativePath, entry.name));
    if (entry.isSymbolicLink()) {
      output.push({ path: childRelativePath, type: "blocked-link" });
      continue;
    }

    try {
      const safeChild = await resolveReviewExistingPath(workspaceRoot, childRelativePath);
      output.push({
        path: childRelativePath,
        type: safeChild.stats.isFile()
          ? "file"
          : safeChild.stats.isDirectory()
            ? "directory"
            : "other",
      });
    } catch (error) {
      if (error instanceof ReviewAccessDeniedError) {
        output.push({ path: childRelativePath, type: "blocked-link" });
        continue;
      }
      throw error;
    }
  }

  return output;
}

export async function searchReviewFiles(
  workspaceRoot: string,
  query: string,
  inputPath = ".",
  requestedMaxResults = MAX_SEARCH_RESULTS,
): Promise<ReviewSearchMatch[]> {
  if (!query) throw new Error("Search query must not be empty.");
  const maxResults = Math.min(Math.max(1, Math.floor(requestedMaxResults)), MAX_SEARCH_RESULTS);
  const start = await resolveReviewExistingPath(workspaceRoot, inputPath);
  const files = start.stats.isFile()
    ? [start.relativePath]
    : await collectSafeFiles(workspaceRoot, start.relativePath);
  const normalizedQuery = query.toLocaleLowerCase();
  const matches: ReviewSearchMatch[] = [];

  for (const path of files.slice(0, MAX_SEARCH_FILES)) {
    let content: string;
    try {
      content = await readReviewTextFile(workspaceRoot, path);
    } catch (error) {
      if (
        error instanceof ReviewAccessDeniedError
        || (error instanceof Error && error.message.includes("review limit"))
      ) {
        continue;
      }
      throw error;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        path,
        line: index + 1,
        text: line.slice(0, MAX_RESULT_LINE_CHARACTERS),
      });
      if (matches.length >= maxResults) return matches;
    }
  }

  return matches;
}

export async function writeHandoffDocument(
  workspaceRoot: string,
  document: HandoffDocument,
  content: string,
): Promise<string> {
  const relativePath = HANDOFF_PATHS[document];
  const maximumBytes = document === "state" ? MAX_HANDOFF_STATE_BYTES : MAX_HANDOFF_MARKDOWN_BYTES;
  if (Buffer.byteLength(content, "utf8") > maximumBytes) {
    throw new Error(`Handoff content exceeds the ${maximumBytes}-byte limit.`);
  }

  const normalizedContent = document === "state" ? normalizeStateJson(content) : content;
  const safePath = await resolveReviewExistingPath(workspaceRoot, relativePath, "file");
  const handle = await open(safePath.absolutePath, "r+");
  try {
    await verifyOpenHandle(workspaceRoot, relativePath, safePath, handle);
    await handle.truncate(0);
    await handle.writeFile(normalizedContent, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  return relativePath;
}

export async function findReviewInstructionFiles(
  workspaceRoot: string,
  inputPath = ".",
): Promise<string[]> {
  const files = await collectSafeFiles(workspaceRoot, inputPath);
  return files.filter((path) => {
    const name = basename(path).toUpperCase();
    return name === "AGENTS.MD" || name === "CLAUDE.MD";
  });
}

async function collectSafeFiles(workspaceRoot: string, inputPath: string): Promise<string[]> {
  const safeDirectory = await resolveReviewExistingPath(workspaceRoot, inputPath, "directory");
  const files: string[] = [];
  const pending = [safeDirectory.relativePath];

  while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
    const currentRelativePath = pending.pop() ?? ".";
    const current = await resolveReviewExistingPath(workspaceRoot, currentRelativePath, "directory");
    const entries = await readdir(current.absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRelativePath = toWorkspacePath(join(current.relativePath, entry.name));
      let child: SafeExistingPath;
      try {
        child = await resolveReviewExistingPath(workspaceRoot, childRelativePath);
      } catch (error) {
        if (error instanceof ReviewAccessDeniedError) continue;
        throw error;
      }

      if (child.stats.isFile()) {
        files.push(child.relativePath);
        if (files.length >= MAX_SEARCH_FILES) break;
      } else if (child.stats.isDirectory() && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        pending.push(child.relativePath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function resolveReviewExistingPath(
  workspaceRoot: string,
  inputPath: string,
  expectedType?: "file" | "directory",
): Promise<SafeExistingPath> {
  const canonicalRoot = await canonicalDirectory(workspaceRoot, "Workspace root");
  const candidate = resolve(canonicalRoot, inputPath);
  if (!isPathInside(candidate, canonicalRoot)) {
    throw new ReviewAccessDeniedError(`Path is outside the workspace root: ${inputPath}`);
  }

  assertReviewPathNotSensitive(relative(canonicalRoot, candidate));

  await assertNoRedirectingSegments(canonicalRoot, candidate, canonicalRoot);
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink()) {
    throw new ReviewAccessDeniedError(`Symbolic links and junctions are not readable: ${inputPath}`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    throw new ReviewAccessDeniedError(`Expected a regular file: ${inputPath}`);
  }
  if (expectedType === "directory" && !stats.isDirectory()) {
    throw new ReviewAccessDeniedError(`Expected a directory: ${inputPath}`);
  }
  if (stats.isFile() && stats.nlink > 1) {
    throw new ReviewAccessDeniedError(`Hard-linked files are not readable: ${inputPath}`);
  }

  const canonicalTarget = await realpath(candidate);
  if (!isPathInside(canonicalTarget, canonicalRoot)) {
    throw new ReviewAccessDeniedError(`Path resolves outside the workspace root: ${inputPath}`);
  }
  assertReviewPathNotSensitive(relative(canonicalRoot, canonicalTarget));

  return {
    absolutePath: canonicalTarget,
    relativePath: toWorkspacePath(relative(canonicalRoot, canonicalTarget) || "."),
    stats,
  };
}

function assertReviewPathNotSensitive(relativePath: string): void {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    const normalized = segment.toLowerCase();
    if (BLOCKED_REVIEW_PATH_SEGMENTS.has(normalized)) {
      throw new ReviewAccessDeniedError(`Sensitive repository path is not readable: ${relativePath}`);
    }
  }

  const filename = segments.at(-1)?.toLowerCase() ?? "";
  if (process.platform === "win32" && segments.some((segment) => segment.includes(":"))) {
    throw new ReviewAccessDeniedError(`Windows alternate data streams are not readable: ${relativePath}`);
  }
  if (
    (filename === ".env" || (filename.startsWith(".env.") && filename !== ".env.example"))
    || BLOCKED_REVIEW_FILENAMES.has(filename)
    || [...BLOCKED_REVIEW_EXTENSIONS].some((extension) => filename.endsWith(extension))
  ) {
    throw new ReviewAccessDeniedError(`Sensitive repository file is not readable: ${relativePath}`);
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const lexicalPath = resolve(expandHomePath(path));
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(lexicalPath);
  } catch {
    throw new ReviewAccessDeniedError(`${label} does not exist.`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ReviewAccessDeniedError(`${label} must be a real directory, not a link or junction.`);
  }

  const canonicalPath = await realpath(lexicalPath);
  if (!samePath(lexicalPath, canonicalPath)) {
    throw new ReviewAccessDeniedError(`${label} must be addressed by its canonical filesystem path.`);
  }
  return canonicalPath;
}

async function assertNoRedirectingSegments(
  lexicalRoot: string,
  lexicalTarget: string,
  canonicalRoot: string,
): Promise<void> {
  const relationship = relative(lexicalRoot, lexicalTarget);
  if (relationship === "") return;
  if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`)) {
    throw new ReviewAccessDeniedError("Path is outside the canonical workspace root.");
  }

  let current = lexicalRoot;
  for (const segment of relationship.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch {
      throw new ReviewAccessDeniedError("Safe resolution requires every target path segment to exist.");
    }
    if (stats.isSymbolicLink()) {
      throw new ReviewAccessDeniedError("Symbolic links and Windows junctions are not allowed in review paths.");
    }
    const canonicalSegment = await realpath(current);
    if (!isPathInside(canonicalSegment, canonicalRoot)) {
      throw new ReviewAccessDeniedError("A path segment resolves outside the canonical workspace root.");
    }
  }
}

async function verifyOpenHandle(
  workspaceRoot: string,
  inputPath: string,
  expectedPath: SafeExistingPath,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const currentPath = await resolveReviewExistingPath(workspaceRoot, inputPath, "file");
  const openedStats = await handle.stat();
  const currentStats = currentPath.stats;
  if (
    !samePath(currentPath.absolutePath, expectedPath.absolutePath)
    || openedStats.dev !== expectedPath.stats.dev
    || openedStats.ino !== expectedPath.stats.ino
    || openedStats.dev !== currentStats.dev
    || openedStats.ino !== currentStats.ino
  ) {
    throw new ReviewAccessDeniedError("File identity changed during the operation.");
  }
}

function normalizeStateJson(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("STATE.json content must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("STATE.json content must be a JSON object.");
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function isPathInside(path: string, root: string): boolean {
  const relationship = relative(root, path);
  return relationship === "" || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function toWorkspacePath(path: string): string {
  if (!path || path === ".") return ".";
  return path.split(sep).join("/");
}
