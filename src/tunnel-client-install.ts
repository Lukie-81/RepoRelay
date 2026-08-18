import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isRegularFile, pathExists } from "./tunnel-config.js";
import { reporelayTunnelDir } from "./user-config.js";
import { extractZipBuffer } from "./zip-safe.js";

export interface TunnelClientArtifact {
  file: string;
  sha256: string;
  executable: string;
  companion: string;
}

/**
 * RepoRelay-pinned tunnel-client manifest.
 *
 * RepoRelay deliberately does not follow `releases/latest`: it executes only a
 * version that has been tested and whose official SHA-256 checksums are pinned
 * here. Update this manifest only after testing a new tunnel-client release.
 *
 * Source of truth (official OpenAI distribution):
 * https://github.com/openai/tunnel-client/releases/tag/v0.0.11
 * SHA256SUMS.txt published with the release, verified locally against the
 * downloaded artifacts before pinning.
 */
export const SUPPORTED_TUNNEL_CLIENT: {
  version: string;
  downloadBaseUrl: string;
  artifacts: Record<string, TunnelClientArtifact>;
} = {
  version: "v0.0.11",
  downloadBaseUrl: "https://github.com/openai/tunnel-client/releases/download/v0.0.11",
  artifacts: {
    "windows-amd64": {
      file: "tunnel-client-v0.0.11-windows-amd64.zip",
      sha256: "eb912c86c6ccde90cda805cb17009507176a656725cf86c36fabe1901a12e29b",
      executable: "tunnel-client.exe",
      companion: "cloudflared.exe",
    },
    "windows-arm64": {
      file: "tunnel-client-v0.0.11-windows-arm64.zip",
      sha256: "38f015a720404c8ccd5976a0d6aed18d931899697eaf208548b5eb3d0f6e8592",
      executable: "tunnel-client.exe",
      companion: "cloudflared.exe",
    },
    "darwin-amd64": {
      file: "tunnel-client-v0.0.11-darwin-amd64.zip",
      sha256: "a48c8a37983d9bf9442309cb661cd2f14d7321cfacf72375d7fa31a6a7420db0",
      executable: "tunnel-client",
      companion: "cloudflared",
    },
    "darwin-arm64": {
      file: "tunnel-client-v0.0.11-darwin-arm64.zip",
      sha256: "3685443b057614ff932d2d477dab94be2082e60bcf4e8b4e378bebc89121b714",
      executable: "tunnel-client",
      companion: "cloudflared",
    },
    "linux-amd64": {
      file: "tunnel-client-v0.0.11-linux-amd64.zip",
      sha256: "29adfe5c1399dfb9fda9383f230c324355912f50dc36e2e416b1f1322317b3c4",
      executable: "tunnel-client",
      companion: "cloudflared",
    },
    "linux-arm64": {
      file: "tunnel-client-v0.0.11-linux-arm64.zip",
      sha256: "d8bba47b2a723799a372b0b87d7e4d69304093d3a28837237315fe5406d97e77",
      executable: "tunnel-client",
      companion: "cloudflared",
    },
  },
};

const PLATFORM_KEYS: Record<string, string> = { win32: "windows", darwin: "darwin", linux: "linux" };
const ARCH_KEYS: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export interface ResolvedTunnelClientArtifact extends TunnelClientArtifact {
  key: string;
  platformLabel: string;
}

export function resolveTunnelClientArtifact(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): ResolvedTunnelClientArtifact {
  const osKey = PLATFORM_KEYS[platform];
  const archKey = ARCH_KEYS[arch];
  if (!osKey || !archKey) {
    throw new Error(
      `RepoRelay does not support tunnel-client on ${platform}/${arch}. Supported platforms: Windows, macOS, and Linux on amd64 and arm64.`,
    );
  }
  const key = `${osKey}-${archKey}`;
  const artifact = SUPPORTED_TUNNEL_CLIENT.artifacts[key];
  if (!artifact) {
    throw new Error(`RepoRelay has no RepoRelay-supported tunnel-client build for ${platform}/${arch}.`);
  }
  const platformLabel = osKey === "windows" ? "Windows" : osKey === "darwin" ? "macOS" : "Linux";
  return { ...artifact, key, platformLabel: `${platformLabel} ${archKey === "amd64" ? "AMD64" : "ARM64"}` };
}

export function tunnelClientArtifactUrl(artifact: Pick<TunnelClientArtifact, "file">): string {
  return `${SUPPORTED_TUNNEL_CLIENT.downloadBaseUrl}/${artifact.file}`;
}

export function managedTunnelClientBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayTunnelDir(env), "bin");
}

export function managedTunnelClientVersionDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(managedTunnelClientBinDir(env), SUPPORTED_TUNNEL_CLIENT.version);
}

export function managedTunnelClientExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(managedTunnelClientVersionDir(env), resolveTunnelClientArtifact(process.platform, process.arch).executable);
}

export function isManagedTunnelClientPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolve(path);
  const binRoot = resolve(managedTunnelClientBinDir(env));
  const relationship = relative(binRoot, resolved);
  return relationship !== "" && !isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export class TunnelClientVerificationError extends Error {
  constructor(expected: string, actual: string) {
    super(
      "tunnel-client verification failed.\n\n"
      + `Expected SHA-256:\n${expected}\n\n`
      + `Received SHA-256:\n${actual}\n\n`
      + "The downloaded binary was not executed.",
    );
    this.name = "TunnelClientVerificationError";
  }
}

export function verifySha256(buffer: Buffer, expected: string): void {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new TunnelClientVerificationError(expected, actual);
  }
}

export interface DownloadFileOptions {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  maxBytes?: number;
}

export async function downloadToBuffer(url: string, options: DownloadFileOptions = {}): Promise<Buffer> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  const response = await doFetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) throw new Error("The downloaded tunnel-client archive is unexpectedly large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("The downloaded tunnel-client archive is empty.");
  if (buffer.length > maxBytes) throw new Error("The downloaded tunnel-client archive is unexpectedly large.");
  return buffer;
}

/** The exact known-good file set bundled in each official per-platform archive. */
function expectedArchiveEntries(artifact: ResolvedTunnelClientArtifact): { allowed: Set<string>; executables: Set<string> } {
  const allowed = new Set([artifact.executable, artifact.companion, "cloudflared-manifest.json", "LICENSE"]);
  const executables = new Set([artifact.executable, artifact.companion]);
  return { allowed, executables };
}

/** Extracts only the pinned archive's known file set, with executable modes on Unix. */
export async function extractVerifiedArchive(zipBuffer: Buffer, destDir: string): Promise<string[]> {
  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  const { allowed, executables } = expectedArchiveEntries(artifact);
  const names = await extractZipBuffer(zipBuffer, destDir, { allowedNames: allowed, executableNames: executables });
  for (const name of names) {
    if (executables.has(name)) await chmod(join(destDir, name), 0o755);
  }
  return names;
}

async function isUsableManagedInstall(versionDir: string, artifact: ResolvedTunnelClientArtifact): Promise<boolean> {
  const { allowed } = expectedArchiveEntries(artifact);
  for (const name of allowed) {
    if (!(await isRegularFile(join(versionDir, name)))) return false;
  }
  return true;
}

async function verifyExtractedInstall(stagingDir: string, artifact: ResolvedTunnelClientArtifact): Promise<void> {
  const { allowed } = expectedArchiveEntries(artifact);
  for (const name of allowed) {
    if (!(await isRegularFile(join(stagingDir, name)))) {
      throw new Error(`The verified tunnel-client archive is missing the expected file: ${name}`);
    }
  }
}

export interface EnsureTunnelClientOptions {
  env?: NodeJS.ProcessEnv;
  output?: (line: string) => void;
  /** Test-only injection; defaults to a real HTTPS download from the official release URL. */
  download?: (url: string) => Promise<Buffer>;
  /** Test-only injection; defaults to the pinned-manifest SHA-256 check. */
  verify?: (buffer: Buffer, expectedSha256: string) => void;
  /** Test-only injection; defaults to the safe allowlisted extractor. */
  extract?: (zipBuffer: Buffer, destDir: string) => Promise<string[]>;
}

export interface EnsureTunnelClientResult {
  path: string;
  installed: boolean;
}

/**
 * Returns the RepoRelay-managed tunnel-client executable, installing it if
 * needed. Reuses an existing verified install; otherwise downloads the pinned
 * official archive, verifies its SHA-256, extracts the known file set into a
 * staging directory, and atomically moves it into place.
 */
export async function ensureManagedTunnelClient(options: EnsureTunnelClientOptions = {}): Promise<EnsureTunnelClientResult> {
  const env = options.env ?? process.env;
  const output = options.output ?? (() => undefined);
  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  const versionDir = managedTunnelClientVersionDir(env);
  const executablePath = join(versionDir, artifact.executable);

  if (await isUsableManagedInstall(versionDir, artifact)) {
    output(`✓ tunnel-client ${SUPPORTED_TUNNEL_CLIENT.version} already installed`);
    return { path: executablePath, installed: false };
  }

  output("✓ Downloading official OpenAI tunnel-client");
  const url = tunnelClientArtifactUrl(artifact);
  const buffer = await (options.download ?? downloadToBuffer)(url);
  (options.verify ?? verifySha256)(buffer, artifact.sha256);
  output("✓ Download verified");

  const binDir = managedTunnelClientBinDir(env);
  await mkdir(binDir, { recursive: true });
  const stagingDir = join(binDir, `.staging-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    const extract = options.extract ?? extractVerifiedArchive;
    await extract(buffer, stagingDir);
    await verifyExtractedInstall(stagingDir, artifact);
    if (await pathExists(versionDir)) await rm(versionDir, { recursive: true, force: true });
    await rename(stagingDir, versionDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  output("✓ tunnel-client installed");
  return { path: executablePath, installed: true };
}

export const OFFICIAL_OPENAI_URLS = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  apiKeys: "https://platform.openai.com/settings/organization/api-keys",
} as const;

export type OfficialOpenaiUrl = (typeof OFFICIAL_OPENAI_URLS)[keyof typeof OFFICIAL_OPENAI_URLS];

export interface OpenOfficialUrlOptions {
  interactive?: boolean;
  noOpen?: boolean;
  output?: (line: string) => void;
  /** Test-only injection for the browser launcher. */
  openCommand?: (command: string, args: string[]) => Promise<boolean>;
}

/**
 * Opens a pre-approved official OpenAI page in the user's default browser using
 * fixed platform commands with argument arrays (no shell interpolation).
 * Convenience only: never opens in non-interactive mode or with --no-open, and
 * falls back to printing the URL when launching fails.
 */
export async function openOfficialUrl(url: string, options: OpenOfficialUrlOptions = {}): Promise<boolean> {
  const output = options.output ?? (() => undefined);
  const officialValues = Object.values(OFFICIAL_OPENAI_URLS) as readonly string[];
  if (!officialValues.includes(url)) {
    throw new Error(`Refusing to open a non-official URL: ${url}`);
  }
  if (options.noOpen === true || options.interactive === false) return false;

  const command = browserOpenCommand(url);
  if (!command) {
    output("Could not open your browser automatically.");
    output(`Open this page manually: ${url}`);
    return false;
  }
  const run = options.openCommand ?? defaultOpenCommand;
  try {
    const launched = await run(command.command, command.args);
    if (!launched) {
      output("Could not open your browser automatically.");
      output(`Open this page manually: ${url}`);
    }
    return launched;
  } catch {
    output("Could not open your browser automatically.");
    output(`Open this page manually: ${url}`);
    return false;
  }
}

function browserOpenCommand(url: string): { command: string; args: string[] } | undefined {
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "linux") return { command: "xdg-open", args: [url] };
  return undefined;
}

export async function defaultOpenCommand(command: string, args: string[]): Promise<boolean> {
  return await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      resolveExit(opened);
    };
    // Keep the launcher referenced until it reports success or failure. An
    // unrefed child can let Node exit while this promise is still pending.
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: true });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}
