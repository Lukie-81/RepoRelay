import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  defaultBridgeSecretFile,
  defaultTunnelConfigFile,
  defaultTunnelProfileDir,
  defaultTunnelProfileFile,
  defaultTunnelRuntimeApiKeyFile,
  defaultTunnelSecretDir,
  protectUserSecretFile,
  reporelayTunnelDir,
} from "./user-config.js";

const execFileAsync = promisify(execFile);

export const TUNNEL_PROFILE = "reporelay";
export const DEFAULT_REPORELAY_MCP_URL = "http://127.0.0.1:7676/mcp";
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const BRIDGE_SECRET_MIN_LENGTH = 32;
const GENERATED_PROFILE_MARKER = "# RepoRelay-managed tunnel-client profile.";
const TUNNEL_CLIENT_DOWNLOAD_URL = "https://github.com/openai/tunnel-client/releases/latest";

export const TUNNEL_ID_PROMPT_HINT: readonly string[] = [
  "1. Tunnel ID",
  "   Get it from OpenAI Platform → Secure MCP Tunnels:",
  "   https://platform.openai.com/settings/organization/tunnels",
  "",
];

export const RUNTIME_API_KEY_PROMPT_HINT: readonly string[] = [
  "2. Runtime API key",
  "   Create one in OpenAI Platform → API keys:",
  "   https://platform.openai.com/settings/organization/api-keys",
  "",
  "   Choose your project and create a new secret key.",
  "   Your account needs Tunnels Read + Use permission.",
  "",
];

export const CHATGPT_COMPLETION_CHECKLIST: readonly string[] = [
  "ChatGPT Web completion checklist:",
  "  1. Create or select the custom MCP app in ChatGPT.",
  "  2. Choose the tunnel connection and select this tunnel.",
  "  3. Run Scan Tools and verify the tools: exactly 7 with handoffs, or exactly 4 in read-only mode.",
  "  4. Start a new chat and select the RepoRelay app.",
  "Do not enter 127.0.0.1 or localhost, and never paste the runtime API key or bridge secret into ChatGPT.",
];

export interface TunnelPaths {
  root: string;
  configFile: string;
  profileDir: string;
  profileFile: string;
  secretDir: string;
  runtimeApiKeyFile: string;
  bridgeSecretFile: string;
}

export interface TunnelOperatorConfig {
  schemaVersion: 1;
  tunnelId: string;
  profile: typeof TUNNEL_PROFILE;
  tunnelClientPath: string;
}

export interface TunnelSetupOptions {
  env?: NodeJS.ProcessEnv;
  tunnelId?: string;
  tunnelClientPath?: string;
  /** Test-only injection; the CLI never accepts a runtime key as an argument. */
  runtimeApiKey?: string;
  interactive?: boolean;
  output?: (line: string) => void;
  /** Test-only injection for the interactive prompts. */
  readVisibleInput?: (prompt: string) => Promise<string>;
  readHiddenInput?: (prompt: string) => Promise<string>;
}

export interface TunnelSetupResult {
  paths: TunnelPaths;
  config: TunnelOperatorConfig;
}

export interface TunnelClientCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TunnelClientCommandRunner = (
  executable: string,
  args: string[],
) => Promise<TunnelClientCommandResult>;

export interface TunnelDoctorOptions {
  env?: NodeJS.ProcessEnv;
  tunnelClientPath?: string;
  verbose?: boolean;
  output?: (line: string) => void;
  runCommand?: TunnelClientCommandRunner;
}

export interface TunnelRunOptions {
  env?: NodeJS.ProcessEnv;
  output?: (line: string) => void;
  /** Test-only injection; the CLI spawns the real tunnel-client. */
  spawnClient?: (executable: string, args: string[]) => Promise<number>;
}

export function getTunnelPaths(env: NodeJS.ProcessEnv = process.env): TunnelPaths {
  return {
    root: reporelayTunnelDir(env),
    configFile: defaultTunnelConfigFile(env),
    profileDir: defaultTunnelProfileDir(env),
    profileFile: defaultTunnelProfileFile(env),
    secretDir: defaultTunnelSecretDir(env),
    runtimeApiKeyFile: defaultTunnelRuntimeApiKeyFile(env),
    bridgeSecretFile: defaultBridgeSecretFile(env),
  };
}

export function buildTunnelClientArgs(command: "doctor" | "run", paths: TunnelPaths): string[] {
  return [command, "--profile", TUNNEL_PROFILE, "--profile-dir", paths.profileDir, ...(command === "doctor" ? ["--explain"] : [])];
}

export function buildTunnelProfile(paths: TunnelPaths, tunnelId: string): string {
  const runtimeApiKeyRef = yamlScalar(fileReference(paths.runtimeApiKeyFile));
  const bridgeSecretRef = yamlScalar(fileReference(paths.bridgeSecretFile));
  return [
    GENERATED_PROFILE_MARKER,
    "# Secret values stay in protected files referenced with file:.",
    "config_version: 1",
    "control_plane:",
    `  tunnel_id: ${yamlScalar(tunnelId)}`,
    `  api_key: ${runtimeApiKeyRef}`,
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: ${yamlScalar(DEFAULT_REPORELAY_MCP_URL)}`,
    "  extra_headers:",
    `    X-RepoRelay-Bridge-Secret: ${bridgeSecretRef}`,
    "  discovery_extra_headers:",
    `    X-RepoRelay-Bridge-Secret: ${bridgeSecretRef}`,
    "",
  ].join("\n");
}

export async function setupTunnel(options: TunnelSetupOptions = {}): Promise<TunnelSetupResult> {
  const env = options.env ?? process.env;
  const output = options.output ?? console.log;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const paths = getTunnelPaths(env);
  const existingConfig = await readOptionalTunnelConfig(paths.configFile);

  const tunnelClientPath = await resolveTunnelClientPath({
    env,
    preferredPath: options.tunnelClientPath,
    storedPath: existingConfig?.tunnelClientPath,
    interactive,
  });

  const promptVisible = options.readVisibleInput ?? readVisibleInput;
  const promptHidden = options.readHiddenInput ?? readHiddenInput;

  output("RepoRelay — ChatGPT Web setup");
  let tunnelId = options.tunnelId?.trim() || existingConfig?.tunnelId;
  if (!tunnelId) {
    requireInteractive(interactive, "Tunnel setup needs a tunnel ID.");
    output("");
    for (const line of TUNNEL_ID_PROMPT_HINT) output(line);
    output("Tunnel ID:");
    tunnelId = (await promptVisible("> ")).trim();
  }
  assertTunnelId(tunnelId);

  await ensureRuntimeApiKeyFile(paths, {
    runtimeApiKey: options.runtimeApiKey,
    interactive,
    output,
    promptHidden,
  });

  await validateSecretFile(paths.bridgeSecretFile, "RepoRelay bridge secret", BRIDGE_SECRET_MIN_LENGTH, true);
  await mkdir(paths.profileDir, { recursive: true });
  const config: TunnelOperatorConfig = {
    schemaVersion: 1,
    tunnelId,
    profile: TUNNEL_PROFILE,
    tunnelClientPath,
  };
  await writeManagedFile(paths.profileFile, buildTunnelProfile(paths, tunnelId), "profile");
  await writeManagedFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "config");

  output("✓ Tunnel ID saved");
  output("✓ Runtime API key stored securely");
  output("✓ RepoRelay bridge secret found");
  output("✓ tunnel-client profile configured");
  output("Configuration saved.");
  output("");
  output("Next:");
  output("  reporelay tunnel doctor");
  return { paths, config };
}

export async function doctorTunnel(options: TunnelDoctorOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const output = options.output ?? console.log;
  output("RepoRelay tunnel doctor");
  let diagnostics = "";
  let redactions: string[] = [];
  try {
    const paths = getTunnelPaths(env);
    const config = await readTunnelConfig(paths.configFile);
    const tunnelClientPath = await resolveTunnelClientPath({
      env,
      preferredPath: options.tunnelClientPath,
      storedPath: config.tunnelClientPath,
      interactive: false,
    });
    await validateTunnelState(paths, config);
    if (options.verbose) redactions = await readSecretValues(paths);
    output("✓ tunnel-client found");
    output("✓ tunnel-client profile configured");
    const result = await (options.runCommand ?? runTunnelClientCommand)(tunnelClientPath, buildTunnelClientArgs("doctor", paths));
    diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (isSuccessfulDoctorResult(result)) {
      output("✓ Tunnel configuration valid");
      output("✓ OpenAI runtime credential accepted");
      output("✓ RepoRelay reachable");
      output("✓ Bridge authentication working");
      output("Ready.");
      output("");
      output("Next:");
      output("  reporelay tunnel run");
      return true;
    }

    output(`✗ tunnel-client doctor failed (exit code ${result.exitCode})`);
    output(nextDoctorStep(diagnostics));
    output("Run `reporelay tunnel doctor --verbose` for diagnostics.");
    if (options.verbose) printDiagnostics(output, diagnostics, redactions);
    return false;
  } catch (error) {
    output(`✗ ${error instanceof Error ? error.message : String(error)}`);
    output("Next: run `reporelay tunnel setup` and then retry the doctor.");
    if (options.verbose && diagnostics) printDiagnostics(output, diagnostics, redactions);
    return false;
  }
}

function isSuccessfulDoctorResult(result: TunnelClientCommandResult): boolean {
  if (result.exitCode === 0) return true;
  if (result.exitCode !== 2) return false;
  return /^FAILED_CHECKS oauth_metadata\s*$/m.test(result.stdout)
    && /^CHECK profile_load\s+PASS\b/m.test(result.stdout)
    && /^CHECK control_plane_api_key\s+PASS\b/m.test(result.stdout)
    && /^CHECK mcp_server_reachable\s+PASS\s+HTTP 401\b/m.test(result.stdout);
}

export async function runTunnel(options: TunnelRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const output = options.output ?? console.log;
  const paths = getTunnelPaths(env);
  const config = await readTunnelConfig(paths.configFile);
  await validateTunnelState(paths, config);
  const tunnelClientPath = await resolveTunnelClientPath({
    env,
    storedPath: config.tunnelClientPath,
    interactive: false,
  });
  output("RepoRelay tunnel");
  output("✓ Profile loaded");
  output("✓ Forwarding RepoRelay MCP through the OpenAI Secure MCP Tunnel");
  for (const line of CHATGPT_COMPLETION_CHECKLIST) output(line);
  output("Keep this window open. Press Ctrl+C to stop.");
  const spawnClient = options.spawnClient ?? ((executable: string, args: string[]) => spawnTunnelClient(executable, args, output));
  return await spawnClient(tunnelClientPath, buildTunnelClientArgs("run", paths));
}

async function spawnTunnelClient(executable: string, args: string[], output: (line: string) => void): Promise<number> {
  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolveExit(exitCode);
    };
    const child = spawn(executable, args, { stdio: "inherit", windowsHide: false });
    child.once("error", (error) => {
      output(`✗ Could not start tunnel-client: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") finish(0);
      else finish(code ?? 1);
    });
  });
}

async function runTunnelClientCommand(executable: string, args: string[]): Promise<TunnelClientCommandResult> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return {
      exitCode,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

async function validateTunnelState(paths: TunnelPaths, config: TunnelOperatorConfig): Promise<void> {
  if (config.profile !== TUNNEL_PROFILE) throw new Error(`Unsupported tunnel profile in ${paths.configFile}.`);
  await assertRegularFile(paths.profileFile, "RepoRelay tunnel profile");
  const profile = await readFile(paths.profileFile, "utf8");
  assertNoInlineSecrets(profile, paths.profileFile);
  await validateSecretFile(paths.runtimeApiKeyFile, "OpenAI runtime API key", 1, false);
  await validateSecretFile(paths.bridgeSecretFile, "RepoRelay bridge secret", BRIDGE_SECRET_MIN_LENGTH, false);
}

async function readSecretValues(paths: TunnelPaths): Promise<string[]> {
  return [
    (await readFile(paths.runtimeApiKeyFile, "utf8")).trim(),
    (await readFile(paths.bridgeSecretFile, "utf8")).trim(),
  ].filter((value) => value.length > 0);
}

async function ensureRuntimeApiKeyFile(
  paths: TunnelPaths,
  options: {
    runtimeApiKey?: string;
    interactive: boolean;
    output: (line: string) => void;
    promptHidden: (prompt: string) => Promise<string>;
  },
): Promise<boolean> {
  if (await pathExists(paths.runtimeApiKeyFile)) {
    await validateSecretFile(paths.runtimeApiKeyFile, "OpenAI runtime API key", 1, true);
    return false;
  }

  let runtimeApiKey = options.runtimeApiKey;
  if (runtimeApiKey === undefined) {
    requireInteractive(options.interactive, "Tunnel setup needs the OpenAI runtime API key once.");
    for (const line of RUNTIME_API_KEY_PROMPT_HINT) options.output(line);
    options.output("Runtime API key (input hidden):");
    runtimeApiKey = await options.promptHidden("> ");
  }
  runtimeApiKey = runtimeApiKey.trim();
  if (!runtimeApiKey) throw new Error("The OpenAI runtime API key cannot be empty.");
  await mkdir(paths.secretDir, { recursive: true });
  try {
    await writeFile(paths.runtimeApiKeyFile, `${runtimeApiKey}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    await validateSecretFile(paths.runtimeApiKeyFile, "OpenAI runtime API key", 1, true);
    return false;
  }
  await protectUserSecretFile(paths.runtimeApiKeyFile);
  return true;
}

async function validateSecretFile(path: string, label: string, minimumLength: number, protect: boolean): Promise<void> {
  await assertRegularFile(path, label);
  if (protect) await protectUserSecretFile(path);
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < minimumLength) throw new Error(`${label} at ${path} is empty or too short.`);
}

async function readOptionalTunnelConfig(path: string): Promise<TunnelOperatorConfig | undefined> {
  if (!(await pathExists(path))) return undefined;
  return await readTunnelConfig(path);
}

async function readTunnelConfig(path: string): Promise<TunnelOperatorConfig> {
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
  return {
    schemaVersion: 1,
    tunnelId: parsed.tunnelId,
    profile: TUNNEL_PROFILE,
    tunnelClientPath: resolve(parsed.tunnelClientPath),
  };
}

async function writeManagedFile(path: string, content: string, kind: "config" | "profile"): Promise<void> {
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

async function resolveTunnelClientPath(options: {
  env: NodeJS.ProcessEnv;
  preferredPath?: string;
  storedPath?: string;
  interactive: boolean;
}): Promise<string> {
  if (options.preferredPath?.trim()) {
    const explicitPath = resolve(options.preferredPath.trim());
    if (!(await isUsableTunnelClient(explicitPath))) throw new Error(`The tunnel-client executable was not found at ${explicitPath}.`);
    return explicitPath;
  }
  if (options.storedPath?.trim()) {
    const storedPath = resolve(options.storedPath.trim());
    if (await isUsableTunnelClient(storedPath)) return storedPath;
  }
  const pathClient = await findTunnelClientOnPath(options.env);
  if (pathClient) return pathClient;
  if (!options.interactive) throw missingTunnelClientError();
  requireInteractive(true, "Tunnel setup needs tunnel-client.");
  const enteredPath = (await readVisibleInput("tunnel-client executable path (leave blank to cancel): ")).trim();
  if (!enteredPath) throw missingTunnelClientError();
  const explicitPath = resolve(enteredPath);
  if (!(await isUsableTunnelClient(explicitPath))) throw new Error(`The tunnel-client executable was not found at ${explicitPath}.`);
  return explicitPath;
}

async function findTunnelClientOnPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = env.PATH ?? "";
  const names = process.platform === "win32" ? ["tunnel-client.exe", "tunnel-client"] : ["tunnel-client"];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isUsableTunnelClient(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

async function isUsableTunnelClient(path: string): Promise<boolean> {
  if (process.platform === "win32" && !/\.(?:exe|com)$/i.test(path)) return false;
  return await isRegularFile(path);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) throw new Error(`${label} was not found at ${path}.`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) throw new Error(`${label} must be a regular single-link file: ${path}.`);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function assertTunnelId(tunnelId: string): void {
  if (!TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new Error("Tunnel ID must look like tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
}

function fileReference(path: string): string {
  const normalizedPath = resolve(path).replaceAll("\\", "/");
  return `file:${normalizedPath}`;
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertNoInlineSecrets(profile: string, path: string): void {
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

function nextDoctorStep(diagnostics: string): string {
  const lower = diagnostics.toLowerCase();
  if (/connection refused|mcp_server_reachable|127\.0\.0\.1:7676/.test(lower)) {
    return "Start RepoRelay with `reporelay quickstart <repository>` and rerun the doctor.";
  }
  if (/bridge|401|unauthorized|forbidden/.test(lower)) {
    return "Check that RepoRelay is running with its canonical bridge secret, then rerun the doctor.";
  }
  if (/api key|api_key|tunnel id|tunnel_id|control_plane/.test(lower)) {
    return "Check the tunnel ID and the protected runtime API-key file, then rerun the doctor.";
  }
  return "Check the tunnel-client quickstart guidance and rerun the doctor.";
}

function printDiagnostics(output: (line: string) => void, diagnostics: string, redactions: string[] = []): void {
  let redacted = diagnostics;
  for (const secret of redactions) redacted = redacted.replaceAll(secret, "[redacted]");
  const safeLines = redacted
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/(api[_ -]?key|authorization|bearer|secret|token)/i.test(line));
  if (safeLines.length === 0) return;
  output("Diagnostics:");
  for (const line of safeLines.slice(-30)) output(line);
}

function missingTunnelClientError(): Error {
  return new Error(`tunnel-client was not found. Download the official client from ${TUNNEL_CLIENT_DOWNLOAD_URL}, install it or place it on PATH, then rerun reporelay tunnel setup.`);
}

function requireInteractive(interactive: boolean, message: string): void {
  if (!interactive) throw new Error(`${message} Run the command in an interactive terminal.`);
}

async function readVisibleInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive tunnel setup requires a terminal.");
  const readline = await import("node:readline/promises");
  const interfaceHandle = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await interfaceHandle.question(prompt);
  } finally {
    interfaceHandle.close();
  }
}

async function readHiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The runtime API key prompt requires an interactive terminal.");
  const input = process.stdin;
  process.stdout.write(prompt);
  return await new Promise<string>((resolveInput, rejectInput) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    };
    function onData(chunk: Buffer | string): void {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          rejectInput(new Error("Runtime API key entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolveInput(value.trim());
          return;
        }
        if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
