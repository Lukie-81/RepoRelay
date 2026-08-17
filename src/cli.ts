#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSecurityAudit, resolveAuditBridgeSecret, runSecurityAudit } from "./audit.js";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { startQuickstart, type QuickstartSummary } from "./quickstart.js";
import { reporelayConfigDir } from "./user-config.js";
import { shutdownHttpServer } from "./server-shutdown.js";

type Command = "serve" | "quickstart" | "audit" | "doctor" | "help" | "version";
const SUPPORTED_NODE_MAJOR = 22;
const SUPPORTED_NODE_MIN_MINOR = 19;
const SUPPORTED_NODE_MAX_MAJOR = 27;

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();
  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);
  switch (command) {
    case "serve":
      await serve();
      return;
    case "quickstart":
      await runQuickstart(args);
      return;
    case "audit":
      await runAudit(args);
      return;
    case "doctor":
      runDoctor();
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "quickstart" || command === "audit" || command === "doctor") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

function assertSupportedNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > SUPPORTED_NODE_MAJOR && major < SUPPORTED_NODE_MAX_MAJOR
    || major === SUPPORTED_NODE_MAJOR && minor >= SUPPORTED_NODE_MIN_MINOR;
  if (!supported) throw new Error(`RepoRelay requires Node.js >=22.19 and <27; found ${process.version}.`);
}

interface QuickstartArgs {
  repositoryRoot: string;
  port: number;
  secretFile?: string;
  appendAgentInstructions: boolean;
  handoffWrites: boolean;
}

interface AuditArgs {
  repositoryRoot: string;
  json: boolean;
  secretFile?: string;
  handoffWrites?: boolean;
}

function parseQuickstartArgs(args: string[]): QuickstartArgs {
  const positional: string[] = [];
  const parsed: QuickstartArgs = { repositoryRoot: process.cwd(), port: 7676, appendAgentInstructions: false, handoffWrites: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[++index];
      const port = Number(value);
      if (!value || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port expects a port between 1 and 65535.");
      parsed.port = port;
    } else if (arg === "--secret-file") {
      const value = args[++index];
      if (!value) throw new Error("--secret-file expects a file path.");
      parsed.secretFile = value;
    } else if (arg === "--append-agent-instructions") parsed.appendAgentInstructions = true;
    else if (arg === "--no-handoff-writes") parsed.handoffWrites = false;
    else if (arg?.startsWith("-")) throw new Error(`Unknown quickstart option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Usage: reporelay quickstart [repository-root] [--port <port>] [--secret-file <path>] [--append-agent-instructions] [--no-handoff-writes]");
  if (positional[0]) parsed.repositoryRoot = positional[0];
  return parsed;
}

async function runQuickstart(args: string[]): Promise<void> {
  const parsed = parseQuickstartArgs(args);
  const runtime = await startQuickstart({
    repositoryRoot: resolve(parsed.repositoryRoot),
    port: parsed.port,
    secretFile: parsed.secretFile,
    appendAgentInstructions: parsed.appendAgentInstructions,
    handoffWrites: parsed.handoffWrites,
  });
  printQuickstartSummary(runtime.summary);
  await waitForSignals(runtime.stop, "quickstart");
}

function parseAuditArgs(args: string[]): AuditArgs {
  const positional: string[] = [];
  const parsed: AuditArgs = { repositoryRoot: "", json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--no-handoff-writes") parsed.handoffWrites = false;
    else if (arg === "--secret-file") {
      const value = args[++index];
      if (!value) throw new Error("--secret-file expects a file path.");
      parsed.secretFile = value;
    } else if (arg?.startsWith("-")) throw new Error(`Unknown audit option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  if (positional.length !== 1) throw new Error("Usage: reporelay audit <repository-root> [--json] [--secret-file <path>]");
  parsed.repositoryRoot = positional[0] as string;
  return parsed;
}

async function runAudit(args: string[]): Promise<void> {
  const parsed = parseAuditArgs(args);
  const secret = await resolveAuditBridgeSecret({ secretFile: parsed.secretFile });
  const report = await runSecurityAudit({
    repositoryRoot: parsed.repositoryRoot,
    bridgeSecret: secret.secret,
    bridgeSecretError: secret.error,
    handoffWrites: parsed.handoffWrites,
  });
  if (parsed.json) console.log(JSON.stringify(report));
  else console.log(formatSecurityAudit(report));
  if (!report.passed) process.exitCode = 1;
}

function printQuickstartSummary(summary: QuickstartSummary): void {
  const handoffChanges = [
    ...summary.handoffInit.created.map((path) => `created ${path}`),
    ...summary.handoffInit.preserved.map((path) => `preserved ${path}`),
  ].join(", ");
  console.log("RepoRelay");
  console.log("");
  console.log("Repository");
  console.log(`✓ ${summary.repositoryRoot}`);
  console.log("");
  console.log("Security");
  console.log("✓ Loopback only");
  console.log("✓ Authentication enabled");
  console.log("✓ Repository containment active");
  console.log("");
  console.log("AI permissions");
  console.log("✓ Read");
  console.log("✓ Search");
  console.log(summary.handoffWrites ? "✓ Fixed handoffs" : "— Fixed handoffs disabled");
  console.log("");
  console.log("Blocked");
  console.log("✓ Shell");
  console.log("✓ Git");
  console.log("✓ Processes");
  console.log("✓ Arbitrary writes");
  console.log("");
  console.log("MCP");
  console.log("✓ Bridge running");
  console.log("✓ Security checks passed");
  console.log("✓ Tool surface verified");
  console.log("");
  console.log("Ready.");
  console.log("");
  console.log(`Local MCP: ${summary.localMcpUrl}`);
  console.log(`Bridge secret file: ${summary.bridgeSecretFile}`);
  if (handoffChanges) console.log(`Handoff files: ${handoffChanges}`);
  if (summary.handoffInit.agentsBackupPath) console.log(`AGENTS.md backup: ${summary.handoffInit.agentsBackupPath}`);
  console.log("Next: Connect ChatGPT Web through an OpenAI Secure MCP Tunnel.");
  console.log("Press Ctrl+C to stop.");
}

async function serve(): Promise<void> {
  const running = createServer(loadConfig());
  const httpServer = running.app.listen(running.config.port, running.config.host, () => {
    console.log(`reporelay listening on http://${running.config.host}:${running.config.port}/mcp`);
    console.log(`approved repository: ${running.config.bridgeWorkspaceRoot}`);
    console.log(`handoff writes: ${running.config.handoffWritesEnabled ? "enabled" : "disabled"}`);
    console.log(`public base url: ${running.config.publicBaseUrl}`);
    console.log("authentication: X-RepoRelay-Bridge-Secret required");
  });
  await waitForSignals(() => shutdownHttpServer(httpServer, running.close), "server");
}

async function waitForSignals(stop: () => Promise<void>, label: string): Promise<void> {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void stop().then(() => process.exit(0)).catch((error) => {
      console.error(`reporelay ${label} shutdown failed`, error);
      process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

function runDoctor(): void {
  console.log(`Config directory: ${reporelayConfigDir()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  try {
    const config = loadConfig();
    console.log("Configuration: valid");
    console.log(`Approved repository: ${config.bridgeWorkspaceRoot}`);
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Handoff writes: ${config.handoffWritesEnabled ? "enabled" : "disabled"}`);
    console.log("Bridge authentication: enabled");
    console.log("OAuth routes: absent");
  } catch (error) {
    console.log(`Configuration: invalid (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log([
    "RepoRelay",
    "",
    "A local-first MCP bridge for constrained review of one approved repository.",
    "",
    "Usage:",
    "  reporelay serve           Start the authenticated loopback bridge",
    "  reporelay quickstart     Initialize handoff files and self-test the bridge",
    "  reporelay audit <repo>   Verify repository, bridge, MCP surface, and containment",
    "  reporelay doctor         Show configuration and security status",
    "  reporelay help           Show this help",
    "  reporelay version        Print the installed version",
    "  reporelay --version      Print the installed version",
    "",
    "Quickstart options:",
    "  [repository-root]        Approved repository (defaults to the current directory)",
    "  --port <port>            Loopback port (default: 7676)",
    "  --secret-file <path>     Bridge secret file",
    "  --append-agent-instructions",
    "  --no-handoff-writes      Expose only the four read-only tools",
    "",
    "Audit options:",
    "  --json                   Emit stable machine-readable audit results",
    "  --secret-file <path>     Protected bridge secret file (optional after quickstart)",
    "  --no-handoff-writes      Verify the four-tool read-only surface",
    "",
    "The bridge requires X-RepoRelay-Bridge-Secret and never exposes shell, process, Git, patch, artifact, worktree, skill, subagent, or unrestricted write tools.",
  ].join("\n"));
}

function printVersion(): void {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("Unable to read RepoRelay package version.");
  console.log(packageJson.version);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
