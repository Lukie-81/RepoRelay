import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { reporelayTunnelDir } from "./user-config.js";

export const TUNNEL_PROFILE = "reporelay";
export const DEFAULT_REPORELAY_MCP_URL = "http://127.0.0.1:7676/mcp";
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface TunnelOperatorConfig {
  schemaVersion: 1;
  tunnelId: string;
  profile: typeof TUNNEL_PROFILE;
  tunnelClientPath: string;
  /**
   * Whether the executable is the RepoRelay-managed verified tunnel-client
   * ("managed") or an operator-supplied binary ("custom"). Inferred when absent
   * so existing configurations remain valid.
   */
  tunnelClientSource?: "managed" | "custom";
  /**
   * Convenience local endpoint that tunnel-client forwards to. When absent the
   * default 7676 loopback URL is used, so existing configurations remain valid.
   */
  localMcpUrl?: string;
}

export function assertTunnelId(tunnelId: string): void {
  if (!TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new Error("Tunnel ID must look like tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
}

export function loopbackMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Convenience configuration is loopback-only; arbitrary remote URLs are rejected. */
export function assertLocalMcpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid RepoRelay local MCP URL: ${value}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error("RepoRelay tunnel endpoint must use http on a loopback host.");
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error("RepoRelay tunnel endpoint must target a loopback host (127.0.0.1, localhost, or ::1). Remote URLs are not allowed.");
  }
  if (parsed.pathname !== "/mcp") {
    throw new Error("RepoRelay tunnel endpoint must target the /mcp path.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("RepoRelay tunnel endpoint must not contain a query or fragment.");
  }
  return value;
}

export function resolveLocalMcpUrl(port?: number, existing?: string, hint?: string): string {
  if (port !== undefined) return assertLocalMcpUrl(loopbackMcpUrl(port));
  if (existing) return assertLocalMcpUrl(existing);
  if (hint) return assertLocalMcpUrl(hint);
  return DEFAULT_REPORELAY_MCP_URL;
}

export function activeLocalMcpUrlFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayTunnelDir(env), "local-mcp-url.txt");
}

export async function readActiveLocalMcpUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = activeLocalMcpUrlFile(env);
  if (!(await pathExists(file))) return undefined;
  const value = (await readFile(file, "utf8")).trim();
  if (!value) return undefined;
  return assertLocalMcpUrl(value);
}

export async function writeActiveLocalMcpUrl(env: NodeJS.ProcessEnv, url: string): Promise<void> {
  const file = activeLocalMcpUrlFile(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${assertLocalMcpUrl(url)}\n`, { encoding: "utf8" });
}

export async function readOptionalTunnelConfig(path: string): Promise<TunnelOperatorConfig | undefined> {
  if (!(await pathExists(path))) return undefined;
  return await readTunnelConfig(path);
}

export async function readTunnelConfig(path: string): Promise<TunnelOperatorConfig> {
  await assertRegularFile(path, "RepoRelay tunnel configuration");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`RepoRelay tunnel configuration is not valid JSON: ${path}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.profile !== TUNNEL_PROFILE || typeof parsed.tunnelId !== "string" || typeof parsed.tunnelClientPath !== "string") {
    throw new Error(`RepoRelay tunnel configuration is invalid: ${path}`);
  }
  assertTunnelId(parsed.tunnelId);
  if (!parsed.tunnelClientPath.trim()) throw new Error(`RepoRelay tunnel configuration has no tunnel-client path: ${path}`);
  if (parsed.localMcpUrl !== undefined && typeof parsed.localMcpUrl !== "string") {
    throw new Error(`RepoRelay tunnel configuration is invalid: ${path}`);
  }
  if (parsed.tunnelClientSource !== undefined && parsed.tunnelClientSource !== "managed" && parsed.tunnelClientSource !== "custom") {
    throw new Error(`RepoRelay tunnel configuration is invalid: ${path}`);
  }
  const localMcpUrl = parsed.localMcpUrl === undefined ? undefined : assertLocalMcpUrl(parsed.localMcpUrl);
  const resolvedClientPath = resolve(parsed.tunnelClientPath);
  const managedBinRoot = resolve(dirname(path), "bin");
  const managedRelationship = relative(managedBinRoot, resolvedClientPath);
  const inferredSource = managedRelationship !== "" && !isAbsolute(managedRelationship) && managedRelationship !== ".." && !managedRelationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? "managed"
    : "custom";
  return {
    schemaVersion: 1,
    tunnelId: parsed.tunnelId,
    profile: TUNNEL_PROFILE,
    tunnelClientPath: resolvedClientPath,
    tunnelClientSource: parsed.tunnelClientSource ?? inferredSource,
    ...(localMcpUrl !== undefined ? { localMcpUrl } : {}),
  };
}

/**
 * Keeps the recorded local endpoint in sync with the RepoRelay that is actually
 * running. No-op when no tunnel configuration exists yet; otherwise preserves
 * every other field and backs up the previous file.
 */
export async function updateTunnelConfigLocalMcpUrl(configFile: string, localMcpUrl: string): Promise<boolean> {
  const validated = assertLocalMcpUrl(localMcpUrl);
  const existing = await readOptionalTunnelConfig(configFile);
  if (!existing) return false;
  if (existing.localMcpUrl === validated) return true;
  await writeManagedFile(configFile, `${JSON.stringify({ ...existing, localMcpUrl: validated }, null, 2)}\n`, "config");
  return true;
}

export async function writeManagedFile(path: string, content: string, kind: "config" | "profile"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!(await pathExists(path))) {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return;
  }
  await assertRegularFile(path, `RepoRelay tunnel ${kind}`);
  const current = await readFile(path, "utf8");
  if (current === content) return;
  if (kind === "profile") assertNoInlineSecrets(current, path);
  let backupPath = `${path}.bak-${Date.now()}`;
  let backupSuffix = 1;
  while (await pathExists(backupPath)) backupPath = `${path}.bak-${Date.now()}-${backupSuffix++}`;
  await copyFile(path, backupPath);
  await writeFile(path, content, { encoding: "utf8" });
}

export function assertNoInlineSecrets(profile: string, path: string): void {
  const hasInlineSecret = profile.split(/\r?\n/).some((line) => {
    const match = /^\s*(?:api_key|X-RepoRelay-Bridge-Secret)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) return false;
    const value = (match[1] ?? "").replace(/^(['"])(.*)\1$/, "$2").trim();
    return value.length > 0 && !/^(?:file|env):/i.test(value);
  });
  if (hasInlineSecret) {
    throw new Error(`The existing tunnel profile contains an inline secret and was not changed: ${path}.`);
  }
}

export async function assertRegularFile(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) throw new Error(`${label} was not found at ${path}.`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) throw new Error(`${label} must be a regular single-link file: ${path}.`);
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
