import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_REPORELAY_MCP_URL,
  TUNNEL_PROFILE,
  assertLocalMcpUrl,
  assertNoInlineSecrets,
  assertRegularFile,
  assertTunnelId,
  isErrorCode,
  isRegularFile,
  pathExists,
  readActiveLocalMcpUrl,
  readOptionalTunnelConfig,
  readTunnelConfig,
  resolveLocalMcpUrl,
  writeManagedFile,
  type TunnelOperatorConfig,
} from "./tunnel-config.js";
import {
  OFFICIAL_OPENAI_URLS,
  ensureManagedTunnelClient,
  isManagedTunnelClientPath,
  openOfficialUrl,
  resolveTunnelClientArtifact,
} from "./tunnel-client-install.js";
import {
  defaultBridgeSecretFile,
  defaultTunnelConfigFile,
  defaultTunnelProfileDir,
  defaultTunnelProfileFile,
  defaultTunnelRuntimeApiKeyFile,
  defaultTunnelSecretDir,
  grantUserFullControl,
  protectUserSecretFile,
  reporelayTunnelDir,
} from "./user-config.js";

export { DEFAULT_REPORELAY_MCP_URL, TUNNEL_PROFILE, type TunnelOperatorConfig } from "./tunnel-config.js";

const execFileAsync = promisify(execFile);

const BRIDGE_SECRET_MIN_LENGTH = 32;
const GENERATED_PROFILE_MARKER = "# RepoRelay-managed tunnel-client profile.";
const TUNNEL_CLIENT_DOWNLOAD_URL = "https://github.com/openai/tunnel-client/releases/latest";

export const CHATGPT_COMPLETION_CHECKLIST: readonly string[] = [
  "ChatGPT Web completion checklist:",
  "  1. In ChatGPT (developer mode enabled), add RepoRelay as a custom MCP app",
  "     through the current developer flow — the UI may label this Apps or Plugins.",
  "  2. Choose the tunnel connection and select this tunnel.",
  "  3. When asked for authentication, select No authentication.",
  "  4. Run Scan Tools and verify the tools: exactly 7 with handoffs, or exactly 4 in read-only mode.",
  "  5. Start a new chat and select the RepoRelay integration.",
  "The app is added inside ChatGPT, not on the OpenAI Platform tunnel page.",
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

export interface TunnelSetupOptions {
  env?: NodeJS.ProcessEnv;
  tunnelId?: string;
  /** Advanced override; normal onboarding installs the RepoRelay-managed client. */
  tunnelClientPath?: string;
  /** Loopback port for the local MCP endpoint (default: 7676). */
  port?: number;
  /** Do not launch the default browser (headless/SSH/CI). */
  noOpen?: boolean;
  /** Re-prompt for the tunnel ID even when one is already configured. */
  replaceTunnel?: boolean;
  /** Re-prompt for the runtime API key even when one is already stored. */
  replaceRuntimeKey?: boolean;
  /** Test-only injection; the CLI never accepts a runtime key as an argument. */
  runtimeApiKey?: string;
  interactive?: boolean;
  output?: (line: string) => void;
  /** Test-only injection for the interactive prompts. */
  readVisibleInput?: (prompt: string) => Promise<string>;
  readHiddenInput?: (prompt: string) => Promise<string>;
  /** Test-only injection for the doctor invocation during setup. */
  runCommand?: TunnelClientCommandRunner;
  /** Test-only injection for the bridge-secret probe; defaults to the real fetch. */
  fetchImpl?: typeof fetch;
  /** Test-only injection for opening the official OpenAI pages (command + args). */
  openUrl?: (command: string, args: string[]) => Promise<boolean>;
  /** Test-only injection for the tunnel-client archive download. */
  download?: (url: string) => Promise<Buffer>;
  /** Test-only injection for archive verification. */
  verify?: (buffer: Buffer, expectedSha256: string) => void;
  /** Test-only injection for archive extraction. */
  extract?: (zipBuffer: Buffer, destDir: string) => Promise<string[]>;
}

export interface TunnelSetupResult {
  paths: TunnelPaths;
  config: TunnelOperatorConfig;
  /** False when the automatic connection test after setup did not pass. */
  doctorPassed: boolean;
}

export interface TunnelClientCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TunnelClientCommandRunner = (
  executable: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<TunnelClientCommandResult>;

export interface TunnelDoctorOptions {
  env?: NodeJS.ProcessEnv;
  tunnelClientPath?: string;
  verbose?: boolean;
  output?: (line: string) => void;
  runCommand?: TunnelClientCommandRunner;
  /** Test-only injection for the bridge-secret probe; defaults to the real fetch. */
  fetchImpl?: typeof fetch;
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

export function buildTunnelProfile(paths: TunnelPaths, tunnelId: string, localMcpUrl?: string): string {
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
    `      url: ${yamlScalar(assertLocalMcpUrl(localMcpUrl ?? DEFAULT_REPORELAY_MCP_URL))}`,
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
  const promptVisible = options.readVisibleInput ?? readVisibleInput;
  const promptHidden = options.readHiddenInput ?? readHiddenInput;

  output("RepoRelay — Connect ChatGPT");
  output("");
  output("Checking local setup...");
  await validateSecretFile(paths.bridgeSecretFile, "RepoRelay bridge secret", BRIDGE_SECRET_MIN_LENGTH, true);
  output("✓ RepoRelay bridge found");
  output("✓ Bridge authentication configured");
  output("");

  output("Preparing OpenAI tunnel client...");
  const resolvedClient = await resolveSetupTunnelClient({
    env,
    preferredPath: options.tunnelClientPath,
    interactive,
    output,
    download: options.download,
    verify: options.verify,
    extract: options.extract,
  });
  output("");

  const existingConfig = await readOptionalTunnelConfig(paths.configFile);
  const localMcpUrl = resolveLocalMcpUrl(options.port, existingConfig?.localMcpUrl, await readActiveLocalMcpUrl(env));

  let tunnelId = options.tunnelId?.trim() || (options.replaceTunnel ? undefined : existingConfig?.tunnelId);
  if (tunnelId) {
    assertTunnelId(tunnelId);
    if (options.tunnelId?.trim()) output("✓ Tunnel ID accepted");
    else output("✓ Existing tunnel configuration");
  } else {
    requireInteractive(interactive, "Tunnel setup needs a tunnel ID.");
    output("");
    output("1. Create your OpenAI tunnel");
    output("");
    if (!options.noOpen) output("Opening OpenAI Platform...");
    await openOfficialUrl(OFFICIAL_OPENAI_URLS.tunnels, { interactive, noOpen: options.noOpen, output, openCommand: options.openUrl });
    output("");
    output("Create or select a Secure MCP Tunnel.");
    output("");
    output("When finished, return here and paste the tunnel ID.");
    tunnelId = await promptValidTunnelId(interactive, promptVisible, output);
    output("✓ Tunnel ID accepted");
  }
  output("");

  const keyChanged = await ensureRuntimeApiKeyFile(paths, {
    runtimeApiKey: options.runtimeApiKey,
    interactive,
    output,
    promptHidden,
    replace: options.replaceRuntimeKey,
    noOpen: options.noOpen,
    openUrl: options.openUrl,
  });
  if (!keyChanged) output("✓ Runtime credential found");
  output("✓ RepoRelay bridge secret");
  output("");

  await mkdir(paths.profileDir, { recursive: true });
  const config: TunnelOperatorConfig = {
    schemaVersion: 1,
    tunnelId,
    profile: TUNNEL_PROFILE,
    tunnelClientPath: resolvedClient.path,
    tunnelClientSource: resolvedClient.source,
    localMcpUrl,
  };
  await writeManagedFile(paths.profileFile, buildTunnelProfile(paths, tunnelId, localMcpUrl), "profile");
  await writeManagedFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "config");
  output("✓ Tunnel profile created");
  output(`✓ Local MCP endpoint: ${localMcpUrl}`);
  output("");

  output("Testing connection...");
  const doctor = await performDoctorChecks(paths, config, { tunnelClientPath: resolvedClient.path, runCommand: options.runCommand, fetchImpl: options.fetchImpl });
  if (doctor.passed) {
    output("✓ OpenAI runtime credential");
    output("✓ RepoRelay reachable");
    output("✓ Bridge authentication");
    output("");
    output("Setup complete.");
    output("");
    output("Next:");
    output("  reporelay tunnel run");
    return { paths, config, doctorPassed: true };
  }

  output("✗ Connection test failed");
  output("");
  output(describeSetupDoctorFailure(doctor.diagnostics));
  output("");
  output("Setup was saved, but the connection test did not pass.");
  output("");
  output("Troubleshoot with:");
  output("  reporelay tunnel doctor --verbose");
  return { paths, config, doctorPassed: false };
}

async function resolveSetupTunnelClient(options: {
  env: NodeJS.ProcessEnv;
  preferredPath?: string;
  interactive: boolean;
  output: (line: string) => void;
  download?: (url: string) => Promise<Buffer>;
  verify?: (buffer: Buffer, expectedSha256: string) => void;
  extract?: (zipBuffer: Buffer, destDir: string) => Promise<string[]>;
}): Promise<{ path: string; source: "managed" | "custom" }> {
  if (options.preferredPath?.trim()) {
    const explicitPath = resolve(options.preferredPath.trim());
    if (!(await isUsableTunnelClient(explicitPath))) throw invalidTunnelClientPathError(explicitPath);
    options.output("✓ Using custom tunnel-client (advanced override)");
    options.output("  RepoRelay did not verify or manage this executable.");
    return { path: explicitPath, source: "custom" };
  }

  const artifact = resolveTunnelClientArtifact(process.platform, process.arch);
  options.output(`✓ Detected ${artifact.platformLabel}`);
  const result = await ensureManagedTunnelClient({ env: options.env, output: options.output, download: options.download, verify: options.verify, extract: options.extract });
  return { path: result.path, source: "managed" };
}

async function promptValidTunnelId(
  interactive: boolean,
  promptVisible: (prompt: string) => Promise<string>,
  output: (line: string) => void,
): Promise<string> {
  requireInteractive(interactive, "Tunnel setup needs a tunnel ID.");
  for (;;) {
    output("Tunnel ID:");
    const value = (await promptVisible("> ")).trim();
    if (!value) throw new Error("Tunnel setup cancelled.");
    try {
      assertTunnelId(value);
      return value;
    } catch {
      output("That does not look like a tunnel ID. It should look like tunnel_ followed by 32 lowercase hex characters. Try again.");
    }
  }
}

async function performDoctorChecks(
  paths: TunnelPaths,
  config: TunnelOperatorConfig,
  options: { tunnelClientPath: string; runCommand?: TunnelClientCommandRunner; fetchImpl?: typeof fetch },
): Promise<{ passed: boolean; diagnostics: string; exitCode: number }> {
  await validateTunnelState(paths, config);
  const run = options.runCommand ?? runTunnelClientCommand;
  const result = await run(options.tunnelClientPath, buildTunnelClientArgs("doctor", paths));
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!isSuccessfulDoctorResult(result)) return { passed: false, diagnostics, exitCode: result.exitCode };

  // tunnel-client doctor only checks that the runtime key is present and
  // well-formed locally. Validate it for real against the OpenAI control
  // plane with the same read-only lookup tunnel-client itself performs at
  // startup, so a wrong or expired key is caught here instead of at run time.
  const credential = await verifyRuntimeCredential(options.tunnelClientPath, paths, config.tunnelId, run);
  if (!credential.passed) return { passed: false, diagnostics: credential.diagnostics, exitCode: 2 };

  // tunnel-client doctor treats an HTTP 401 from the MCP origin as
  // "reachable"; it never exercises the profile's bridge secret. Probe the
  // running RepoRelay with the configured secret so auth is verified too.
  const bridge = await verifyBridgeAuthentication(config.localMcpUrl ?? DEFAULT_REPORELAY_MCP_URL, paths.bridgeSecretFile, options.fetchImpl);
  if (!bridge.passed) return { passed: false, diagnostics: bridge.diagnostics, exitCode: 2 };

  return { passed: true, diagnostics, exitCode: result.exitCode };
}

/**
 * Genuinely validates the stored OpenAI runtime API key by performing the same
 * read-only control-plane tunnel lookup tunnel-client itself does at startup
 * (`admin tunnels get`). The key is read from its protected file and passed to
 * the child only through the documented CONTROL_PLANE_API_KEY environment
 * variable - never on argv.
 */
async function verifyRuntimeCredential(
  tunnelClientPath: string,
  paths: TunnelPaths,
  tunnelId: string,
  runCommand: TunnelClientCommandRunner,
): Promise<{ passed: boolean; diagnostics: string }> {
  const apiKey = (await readFile(paths.runtimeApiKeyFile, "utf8")).trim();
  if (!apiKey) return { passed: false, diagnostics: "The OpenAI runtime credential is empty." };
  const result = await runCommand(tunnelClientPath, ["admin", "tunnels", "get", tunnelId], { ...process.env, CONTROL_PLANE_API_KEY: apiKey });
  if (result.exitCode === 0) return { passed: true, diagnostics: "" };
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/401|403|invalid_api_key|unauthorized|forbidden/i.test(output)) {
    return { passed: false, diagnostics: "The OpenAI control plane rejected the runtime credential or tunnel ID." };
  }
  if (/404|not found/i.test(output)) {
    return { passed: false, diagnostics: "The OpenAI control plane could not find the tunnel ID." };
  }
  return { passed: false, diagnostics: "Network error while contacting the OpenAI control plane." };
}

/**
 * Verifies the configured bridge secret against the RepoRelay that is actually
 * running: probes the local MCP endpoint with the secret from the protected
 * file. A 401 means the running RepoRelay uses a different secret; a network
 * failure means it is not running at the configured endpoint.
 */
async function verifyBridgeAuthentication(
  localMcpUrl: string,
  bridgeSecretFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ passed: boolean; diagnostics: string }> {
  const secret = (await readFile(bridgeSecretFile, "utf8")).trim();
  if (!secret) return { passed: false, diagnostics: "The RepoRelay bridge secret is empty." };
  try {
    const response = await fetchImpl(localMcpUrl, {
      headers: { "X-RepoRelay-Bridge-Secret": secret },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) {
      return { passed: false, diagnostics: "The running RepoRelay rejected the configured bridge secret (HTTP 401)." };
    }
    return { passed: true, diagnostics: "" };
  } catch {
    return { passed: false, diagnostics: `RepoRelay is not currently running at ${localMcpUrl}.` };
  }
}

function describeSetupDoctorFailure(diagnostics: string): string {
  const lower = diagnostics.toLowerCase();
  if (/connection refused|econnrefused/.test(lower)) {
    return notRunningMessage();
  }
  if (/bridge|401|unauthorized|forbidden/.test(lower)) {
    return "Bridge authentication failed. Confirm RepoRelay is running with its canonical bridge secret, then retry.";
  }
  if (/mcp_server_reachable|is not currently running/.test(lower)) {
    return notRunningMessage();
  }
  if (/control plane rejected|could not find the tunnel/.test(lower)) {
    return runtimeCredentialRemediation(lower.includes("could not find the tunnel"), "Then rerun `reporelay tunnel setup` (add `--replace-runtime-key` to enter a new key).");
  }
  if (/network error while contacting the openai control plane/.test(lower)) {
    return "Could not reach the OpenAI control plane. Check your internet connection, then retry.";
  }
  if (/api key|api_key|tunnel id|tunnel_id|control_plane/.test(lower)) {
    return runtimeCredentialRemediation(false, "Then rerun `reporelay tunnel setup` (add `--replace-runtime-key` to enter a new key).");
  }
  return "The connection could not be verified. Troubleshoot with `reporelay tunnel doctor --verbose`.";
}

/**
 * Targeted remediation when OpenAI rejects the runtime credential or tunnel
 * lookup. The common causes are context mismatches — a tunnel not associated
 * with the ChatGPT workspace, or a key from a different organization/project —
 * not just a mistyped key. Never includes secret values.
 */
function runtimeCredentialRemediation(tunnelNotFound: boolean, retryLine: string): string {
  return [
    tunnelNotFound
      ? "The OpenAI control plane could not find this tunnel for the runtime credential."
      : "The OpenAI runtime credential or tunnel ID was not accepted.",
    "",
    "Check that:",
    "- the tunnel is associated with the ChatGPT workspace you intend to use (a tunnel tied only to a Platform organization is not selectable in ChatGPT);",
    "- the runtime credential belongs to the same OpenAI organization/project context as the tunnel;",
    "- your account has Tunnels Read + Use permission for the tunnel.",
    "",
    retryLine,
  ].join("\n");
}

function notRunningMessage(): string {
  return [
    "RepoRelay is not currently running.",
    "",
    "Start it in another terminal:",
    "",
    "  reporelay quickstart \"<your-repository-path>\"",
    "",
    "Keep that terminal open, then retry:",
    "",
    "  reporelay tunnel setup",
  ].join("\n");
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
    const localMcpUrl = config.localMcpUrl ?? DEFAULT_REPORELAY_MCP_URL;
    await syncTunnelProfileEndpoint(paths, localMcpUrl);
    const tunnelClientPath = await resolveTunnelClientPath({
      env,
      preferredPath: options.tunnelClientPath,
      storedPath: config.tunnelClientPath,
      interactive: false,
    });
    if (options.verbose) redactions = await readSecretValues(paths);
    output("✓ tunnel-client found");
    output("✓ tunnel-client profile configured");
    output(`✓ Local MCP endpoint: ${localMcpUrl}`);
    const result = await performDoctorChecks(paths, config, { tunnelClientPath, runCommand: options.runCommand, fetchImpl: options.fetchImpl });
    diagnostics = result.diagnostics;
    if (result.passed) {
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
  const localMcpUrl = config.localMcpUrl ?? DEFAULT_REPORELAY_MCP_URL;
  await syncTunnelProfileEndpoint(paths, localMcpUrl);
  await validateTunnelState(paths, config);
  const tunnelClientPath = await resolveTunnelClientPath({
    env,
    storedPath: config.tunnelClientPath,
    interactive: false,
  });
  output("RepoRelay tunnel");
  output("✓ Profile loaded");
  output(`✓ Local MCP endpoint: ${localMcpUrl}`);
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

async function runTunnelClientCommand(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<TunnelClientCommandResult> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      ...(env ? { env } : {}),
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
    replace?: boolean;
    noOpen?: boolean;
    openUrl?: (command: string, args: string[]) => Promise<boolean>;
  },
): Promise<boolean> {
  const keyExists = await pathExists(paths.runtimeApiKeyFile);
  if (keyExists && !options.replace) {
    await validateSecretFile(paths.runtimeApiKeyFile, "OpenAI runtime API key", 1, true);
    return false;
  }

  let runtimeApiKey = options.runtimeApiKey;
  if (runtimeApiKey === undefined) {
    requireInteractive(options.interactive, "Tunnel setup needs the OpenAI runtime API key.");
    options.output("");
    options.output("2. Create your OpenAI runtime API key");
    options.output("");
    if (!options.noOpen) options.output("Opening OpenAI Platform...");
    await openOfficialUrl(OFFICIAL_OPENAI_URLS.apiKeys, { interactive: options.interactive, noOpen: options.noOpen, output: options.output, openCommand: options.openUrl });
    options.output("");
    options.output("Create a runtime API key for the OpenAI project you are using with this tunnel.");
    options.output("");
    options.output("This key authenticates tunnel-client to OpenAI.");
    options.output("It is NOT the RepoRelay bridge secret.");
    options.output("");
    options.output("Paste the API key below.");
    options.output("");
    options.output("Input is hidden; nothing will appear while you paste or type.");
    options.output("");
    for (;;) {
      options.output("Runtime API key:");
      runtimeApiKey = (await options.promptHidden("> ")).trim();
      if (runtimeApiKey) break;
      options.output("No key was entered. Paste the runtime API key again (or press Ctrl+C to cancel).");
    }
  } else {
    runtimeApiKey = runtimeApiKey.trim();
  }
  if (!runtimeApiKey) throw new Error("The OpenAI runtime API key cannot be empty.");

  await mkdir(paths.secretDir, { recursive: true });
  if (keyExists && options.replace) {
    await assertRegularFile(paths.runtimeApiKeyFile, "OpenAI runtime API key");
    await grantUserFullControl(paths.runtimeApiKeyFile);
    await writeFile(paths.runtimeApiKeyFile, `${runtimeApiKey}\n`, { encoding: "utf8", mode: 0o600 });
    await protectUserSecretFile(paths.runtimeApiKeyFile);
    options.output("✓ Runtime API key replaced");
    return true;
  }
  try {
    await writeFile(paths.runtimeApiKeyFile, `${runtimeApiKey}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    await validateSecretFile(paths.runtimeApiKeyFile, "OpenAI runtime API key", 1, true);
    return false;
  }
  await protectUserSecretFile(paths.runtimeApiKeyFile);
  options.output("✓ Runtime API key stored securely");
  return true;
}

async function validateSecretFile(path: string, label: string, minimumLength: number, protect: boolean): Promise<void> {
  await assertRegularFile(path, label);
  if (protect) await protectUserSecretFile(path);
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < minimumLength) throw new Error(`${label} at ${path} is empty or too short.`);
}

async function resolveTunnelClientPath(options: {
  env: NodeJS.ProcessEnv;
  preferredPath?: string;
  storedPath?: string;
  interactive: boolean;
  output?: (line: string) => void;
  readVisibleInput?: (prompt: string) => Promise<string>;
}): Promise<string> {
  if (options.preferredPath?.trim()) {
    const explicitPath = resolve(options.preferredPath.trim());
    if (!(await isUsableTunnelClient(explicitPath))) throw invalidTunnelClientPathError(explicitPath);
    return explicitPath;
  }
  if (options.storedPath?.trim()) {
    const storedPath = resolve(options.storedPath.trim());
    if (await isUsableTunnelClient(storedPath)) return storedPath;
    // A RepoRelay-managed install that is missing or corrupt is repaired
    // automatically from the pinned, verified archive.
    if (isManagedTunnelClientPath(storedPath, options.env)) {
      const repaired = await ensureManagedTunnelClient({ env: options.env });
      if (await isUsableTunnelClient(repaired.path)) return repaired.path;
    }
  }
  const pathClient = await findTunnelClientOnPath(options.env);
  if (pathClient) return pathClient;
  if (!options.interactive) throw missingTunnelClientError();
  const emit = options.output ?? (() => undefined);
  emit("tunnel-client executable path (leave blank to cancel):");
  const readPath = options.readVisibleInput ?? readVisibleInput;
  const enteredPath = (await readPath("> ")).trim();
  if (!enteredPath) throw new Error("Tunnel setup cancelled.");
  const explicitPath = resolve(enteredPath);
  if (!(await isUsableTunnelClient(explicitPath))) throw invalidTunnelClientPathError(explicitPath);
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

function fileReference(path: string): string {
  const normalizedPath = resolve(path).replaceAll("\\", "/");
  return `file:${normalizedPath}`;
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Migrates an existing generated profile so its main channel URL matches the
 * recorded local endpoint. Only the URL line changes; secret references and
 * every other line are preserved, and the previous file is backed up.
 */
async function syncTunnelProfileEndpoint(paths: TunnelPaths, localMcpUrl: string): Promise<void> {
  if (!(await pathExists(paths.profileFile))) return;
  const current = await readFile(paths.profileFile, "utf8");
  const validated = assertLocalMcpUrl(localMcpUrl);
  const urlLinePattern = /^(\s*url:\s*')([^']*)('\s*)$/m;
  const match = urlLinePattern.exec(current);
  if (!match) return;
  if (match[2] === validated) return;
  await writeManagedFile(paths.profileFile, current.replace(urlLinePattern, `$1${validated}$3`), "profile");
}

function nextDoctorStep(diagnostics: string): string {
  const lower = diagnostics.toLowerCase();
  if (/connection refused|econnrefused/.test(lower)) {
    return "Start RepoRelay with `reporelay quickstart <repository>` (add `--port <port>` if you configured a custom port) and rerun the doctor.";
  }
  if (/bridge|401|unauthorized|forbidden/.test(lower)) {
    return "Check that RepoRelay is running with its canonical bridge secret, then rerun the doctor.";
  }
  if (/mcp_server_reachable|is not currently running/.test(lower)) {
    return "Start RepoRelay with `reporelay quickstart <repository>` (add `--port <port>` if you configured a custom port) and rerun the doctor.";
  }
  if (/control plane rejected|could not find the tunnel/.test(lower)) {
    return runtimeCredentialRemediation(lower.includes("could not find the tunnel"), "Then rerun `reporelay tunnel doctor` (`reporelay tunnel setup --replace-runtime-key` enters a new key).");
  }
  if (/network error while contacting the openai control plane/.test(lower)) {
    return "Check your internet connection and rerun the doctor.";
  }
  if (/api key|api_key|tunnel id|tunnel_id|control_plane/.test(lower)) {
    return runtimeCredentialRemediation(false, "Then rerun `reporelay tunnel doctor` (`reporelay tunnel setup --replace-runtime-key` enters a new key).");
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
  return new Error(`tunnel-client was not found. Download the official client from ${TUNNEL_CLIENT_DOWNLOAD_URL}, extract it, place it on PATH, or rerun reporelay tunnel setup with its full path.`);
}

function invalidTunnelClientPathError(path: string): Error {
  return new Error(`The tunnel-client executable was not found at ${path}. Enter the full path to a regular tunnel-client file and rerun reporelay tunnel setup.`);
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
