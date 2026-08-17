import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";

const BRIDGE_SECRET_MIN_LENGTH = 32;

export interface ServerConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  handoffWritesEnabled: boolean;
  bridgeAuth: true;
  bridgeSecret: string;
  bridgeWorkspaceRoot: string;
  logging: LoggingConfig;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid REPORELAY_PORT: ${value}`);
  }
  return port;
}

function parseBoolean(value: string | undefined, name: string, defaultValue = false): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

function isPathInsideOrEqual(candidate: string, parent: string): boolean {
  const relationship = relative(parent, candidate);
  return relationship === ""
    || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function canonicalExistingDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }

  let canonical: string;
  try {
    canonical = realpathSync.native(value);
  } catch {
    throw new Error(`${label} must be an existing directory.`);
  }

  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} must be an existing directory.`);
  }
  return canonical;
}

function assertNarrowApprovedRoot(root: string): void {
  if (samePath(root, parse(root).root)) {
    throw new Error("Approved repository root must not be a drive or filesystem root.");
  }

  const operatorHome = resolve(homedir());
  if (isPathInsideOrEqual(operatorHome, root)) {
    throw new Error("Approved repository root must not be the user home directory or one of its ancestors.");
  }
}

function parseApprovedRoot(value: string | undefined): string {
  const roots = (value ?? process.cwd())
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (roots.length !== 1) {
    throw new Error("REPORELAY_ALLOWED_ROOTS must contain exactly one approved repository root.");
  }

  return resolveApprovedRepositoryRoot(roots[0] as string);
}

export function resolveApprovedRepositoryRoot(value: string): string {
  const requested = resolve(expandHomePath(value));
  assertNarrowApprovedRoot(requested);
  const canonical = canonicalExistingDirectory(requested, "Approved repository root");
  assertNarrowApprovedRoot(canonical);
  return canonical;
}

function parseHosts(value: string | undefined, derivedHosts: string[]): string[] {
  const hosts = (value === undefined ? derivedHosts : value.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(hosts));
  if (unique.length === 0 || unique.includes("*")) {
    throw new Error("REPORELAY_ALLOWED_HOSTS must be a non-empty explicit host allowlist.");
  }
  return unique;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("REPORELAY_PUBLIC_BASE_URL must use http or https.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}

function parseSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret || secret.length < BRIDGE_SECRET_MIN_LENGTH) {
    throw new Error(`REPORELAY_BRIDGE_SECRET must be at least ${BRIDGE_SECRET_MIN_LENGTH} characters.`);
  }
  return secret;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;
  throw new Error(`Invalid REPORELAY_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return value;
  throw new Error(`Invalid REPORELAY_LOG_FORMAT: ${value}`);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.REPORELAY_LOG_LEVEL),
    format: parseLogFormat(env.REPORELAY_LOG_FORMAT),
    requests: parseBoolean(env.REPORELAY_LOG_REQUESTS, "REPORELAY_LOG_REQUESTS", true),
    toolCalls: parseBoolean(env.REPORELAY_LOG_TOOL_CALLS, "REPORELAY_LOG_TOOL_CALLS", true),
  };
}

export function assertRepoRelaySafety(config: Pick<ServerConfig, "host" | "publicBaseUrl" | "allowedRoots" | "allowedHosts" | "bridgeSecret" | "bridgeWorkspaceRoot">): void {
  if (config.host !== "127.0.0.1") {
    throw new Error("RepoRelay requires REPORELAY_HOST exactly 127.0.0.1.");
  }
  if (config.allowedRoots.length !== 1 || !samePath(config.allowedRoots[0] as string, config.bridgeWorkspaceRoot)) {
    throw new Error("RepoRelay requires exactly one allowed root matching the approved repository root.");
  }
  if (config.allowedHosts.includes("*")) {
    throw new Error("RepoRelay forbids wildcard REPORELAY_ALLOWED_HOSTS.");
  }
  const publicUrl = new URL(config.publicBaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname) && publicUrl.protocol !== "https:") {
    throw new Error("RepoRelay requires HTTPS for a non-loopback public URL.");
  }
  if (config.bridgeSecret.length < BRIDGE_SECRET_MIN_LENGTH) {
    throw new Error(`RepoRelay requires a bridge secret of at least ${BRIDGE_SECRET_MIN_LENGTH} characters.`);
  }
  const canonical = canonicalExistingDirectory(config.bridgeWorkspaceRoot, "Approved repository root");
  if (!samePath(canonical, config.bridgeWorkspaceRoot)) {
    throw new Error("Approved repository root must use its canonical filesystem path.");
  }
  assertNarrowApprovedRoot(canonical);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env.REPORELAY_BRIDGE_AUTH !== undefined && env.REPORELAY_BRIDGE_AUTH !== "1") {
    throw new Error("REPORELAY_BRIDGE_AUTH must be exactly 1; RepoRelay never starts an unauthenticated bridge.");
  }

  const host = env.REPORELAY_HOST ?? "127.0.0.1";
  const port = parsePort(env.REPORELAY_PORT);
  const approvedRoot = parseApprovedRoot(env.REPORELAY_ALLOWED_ROOTS);
  const publicBaseUrl = parsePublicBaseUrl(
    env.REPORELAY_PUBLIC_BASE_URL ?? localPublicBaseUrl(host, port),
  );
  const derivedHosts = Array.from(new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
  ]));
  const allowedHosts = parseHosts(env.REPORELAY_ALLOWED_HOSTS, derivedHosts);
  const config: ServerConfig = {
    host,
    port,
    allowedRoots: [approvedRoot],
    allowedHosts,
    publicBaseUrl,
    handoffWritesEnabled: parseBoolean(env.REPORELAY_HANDOFF_WRITES, "REPORELAY_HANDOFF_WRITES"),
    bridgeAuth: true,
    bridgeSecret: parseSecret(env.REPORELAY_BRIDGE_SECRET),
    bridgeWorkspaceRoot: approvedRoot,
    logging: parseLoggingConfig(env),
  };

  assertRepoRelaySafety(config);
  return config;
}
