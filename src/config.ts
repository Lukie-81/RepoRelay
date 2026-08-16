import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex" | "chatgpt-review";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const CHATGPT_BRIDGE_SECRET_MIN_LENGTH = 32;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  handoffWritesEnabled: boolean;
  chatgptBridgeAuth: boolean;
  chatgptBridgeSecret?: string;
  chatgptBridgeWorkspaceRoot?: string;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function isPathInsideOrEqual(candidate: string, parent: string): boolean {
  if (samePath(candidate, parent)) return true;
  const parentWithSeparator = parent.endsWith(parse(parent).root) ? parent : `${parent}${process.platform === "win32" ? "\\" : "/"}`;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(parentWithSeparator.toLowerCase())
    : candidate.startsWith(parentWithSeparator);
}

function canonicalExistingDirectory(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("Bridge workspace root must be an absolute path.");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(value);
  } catch {
    throw new Error("Bridge workspace root must be an existing directory.");
  }

  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error("Bridge workspace root must be an existing directory.");
  }

  return canonicalRoot;
}

function assertNarrowBridgeWorkspaceRoot(root: string): void {
  const filesystemRoot = parse(root).root;
  if (samePath(root, filesystemRoot)) {
    throw new Error("Bridge workspace root must not be a drive or filesystem root.");
  }

  const operatorHome = resolve(homedir());
  if (isPathInsideOrEqual(operatorHome, root)) {
    throw new Error("Bridge workspace root must not be the user home directory or one of its ancestors.");
  }
}

function parseChatgptBridgeWorkspaceRoot(value: string | undefined): string {
  const roots = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  if (roots.length !== 1) {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires exactly one DEVSPACE_ALLOWED_ROOTS entry.");
  }

  assertNarrowBridgeWorkspaceRoot(resolve(roots[0]));
  const canonicalRoot = canonicalExistingDirectory(roots[0]);
  assertNarrowBridgeWorkspaceRoot(canonicalRoot);
  return canonicalRoot;
}

function parseChatgptBridgeAuthFlag(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH must be exactly 1 to enable or 0 to disable.");
}

function parseChatgptBridgeSecret(value: string | undefined, required: boolean): string | undefined {
  if (!required) return undefined;
  const secret = value?.trim();
  if (!secret || secret.length < CHATGPT_BRIDGE_SECRET_MIN_LENGTH) {
    throw new Error(
      `DEVSPACE_CHATGPT_BRIDGE_SECRET must be at least ${CHATGPT_BRIDGE_SECRET_MIN_LENGTH} characters.`,
    );
  }
  return secret;
}

export function assertChatgptBridgeSafety(
  config: Pick<
    ServerConfig,
    | "chatgptBridgeAuth"
    | "chatgptBridgeSecret"
    | "chatgptBridgeWorkspaceRoot"
    | "host"
    | "publicBaseUrl"
    | "toolMode"
    | "handoffWritesEnabled"
    | "allowedRoots"
    | "allowedHosts"
  >,
): void {
  if (!config.chatgptBridgeAuth) return;

  if (config.host !== "127.0.0.1") {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires HOST exactly 127.0.0.1.");
  }
  if (config.toolMode !== "chatgpt-review") {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires DEVSPACE_TOOL_MODE exactly chatgpt-review.");
  }
  if (!config.chatgptBridgeWorkspaceRoot) {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires an operator-selected workspace root.");
  }
  const canonicalBridgeRoot = canonicalExistingDirectory(config.chatgptBridgeWorkspaceRoot);
  assertNarrowBridgeWorkspaceRoot(canonicalBridgeRoot);
  if (config.allowedRoots.length !== 1 || !samePath(config.allowedRoots[0], canonicalBridgeRoot)) {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires the only allowed root to match the operator-selected workspace root.");
  }
  if (config.allowedHosts.includes("*")) {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 forbids wildcard DEVSPACE_ALLOWED_HOSTS.");
  }
  const publicUrl = new URL(config.publicBaseUrl);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname)
    && publicUrl.protocol !== "https:"
  ) {
    throw new Error("DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires HTTPS for a non-loopback public URL.");
  }
  if (
    !config.chatgptBridgeSecret
    || config.chatgptBridgeSecret.length < CHATGPT_BRIDGE_SECRET_MIN_LENGTH
  ) {
    throw new Error(
      `DEVSPACE_CHATGPT_BRIDGE_AUTH=1 requires a bridge secret of at least ${CHATGPT_BRIDGE_SECRET_MIN_LENGTH} characters.`,
    );
  }
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex" || mode === "chatgpt-review") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "chatgpt-review";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(
  env: NodeJS.ProcessEnv,
  ownerToken: string | undefined,
  oauthRequired: boolean,
): OAuthConfig {
  return {
    ownerToken: oauthRequired
      ? parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN")
      : "oauth-disabled-bridge-auth-test-only",
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env.DEVSPACE_CHATGPT_NO_AUTH && env.DEVSPACE_CHATGPT_NO_AUTH !== "0") {
    throw new Error(
      "DEVSPACE_CHATGPT_NO_AUTH is no longer supported; use the fail-closed bridge authentication mode.",
    );
  }
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const toolMode = parseToolMode(env);
  const chatgptBridgeAuth = parseChatgptBridgeAuthFlag(env.DEVSPACE_CHATGPT_BRIDGE_AUTH);
  const chatgptReview = toolMode === "chatgpt-review";
  if (chatgptReview && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("DEVSPACE_TOOL_MODE=chatgpt-review requires a loopback HOST.");
  }
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const chatgptBridgeWorkspaceRoot = chatgptBridgeAuth
    ? parseChatgptBridgeWorkspaceRoot(env.DEVSPACE_ALLOWED_ROOTS)
    : undefined;
  const allowedRoots = chatgptBridgeWorkspaceRoot
    ? [chatgptBridgeWorkspaceRoot]
    : parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots);
  const allowedHosts = parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts);
  const handoffWritesEnabled = chatgptReview && parseBoolean(env.DEVSPACE_HANDOFF_WRITES);
  const chatgptBridgeSecret = parseChatgptBridgeSecret(
    env.DEVSPACE_CHATGPT_BRIDGE_SECRET,
    chatgptBridgeAuth,
  );

  assertChatgptBridgeSafety({
    chatgptBridgeAuth,
    chatgptBridgeSecret,
    chatgptBridgeWorkspaceRoot,
    host,
    publicBaseUrl,
    toolMode,
    handoffWritesEnabled,
    allowedRoots,
    allowedHosts,
  });

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken, !chatgptBridgeAuth),
    allowedRoots,
    allowedHosts,
    publicBaseUrl,
    toolMode,
    handoffWritesEnabled,
    chatgptBridgeAuth,
    chatgptBridgeSecret,
    chatgptBridgeWorkspaceRoot,
    widgets: chatgptReview ? "off" : parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled: chatgptReview
      ? false
      : env.DEVSPACE_ARTIFACTS === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: chatgptReview
      ? false
      : env.DEVSPACE_SKILLS === undefined
        ? true
        : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: chatgptReview
      ? false
      : env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
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
