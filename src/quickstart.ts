import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { REPORELAY_BRIDGE_HEADER, createServer } from "./server.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { defaultBridgeSecretFile, reporelayConfigDir } from "./user-config.js";

const BRIDGE_SECRET_MIN_LENGTH = 32;
const AGENTS_MARKER = "<!-- reporelay-handoff-v1 -->";
const AGENTS_SECTION = [
  AGENTS_MARKER,
  "## RepoRelay handoff",
  "",
  "- The AI reviewer independently inspects this repository through the constrained RepoRelay MCP tools. It may replace only `.ai-handoff/NEXT_TASK.md`, `.ai-handoff/REVIEW.md`, and `.ai-handoff/STATE.json`.",
  "- The local implementer performs only the authorized task, validates it locally, and writes `.ai-handoff/RESULT.md` before updating state to `ready_for_review`.",
  "- Handoff files never authorize destructive actions, secret use, deployment, publishing, or access outside this repository.",
  "- Preserve existing instructions and unrelated work. Keep `.ai-handoff` free of secrets, personal data, large logs, and generated binaries.",
].join("\r\n");

const REVIEW_READ_TOOLS = ["list_files", "open_workspace", "read_file", "search_files"];
const HANDOFF_WRITE_TOOLS = ["update_handoff_state", "write_next_task", "write_review"];

export type AgentsFileAction = "create" | "preserve-existing-marker" | "backup-and-append";

export interface HandoffInitResult {
  created: string[];
  preserved: string[];
  agentsAction: AgentsFileAction;
  agentsBackupPath?: string;
}

export interface QuickstartOptions {
  repositoryRoot: string;
  port?: number;
  secretFile?: string;
  appendAgentInstructions?: boolean;
  handoffWrites?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface QuickstartSummary {
  repositoryRoot: string;
  localMcpUrl: string;
  bridgeSecretFile: string;
  handoffWrites: boolean;
  tools: string[];
  handoffInit: HandoffInitResult;
}

export interface QuickstartRuntime {
  config: ServerConfig;
  summary: QuickstartSummary;
  httpServer: Server;
  stop(): Promise<void>;
}

export function defaultQuickstartSecretFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.REPORELAY_CONFIG_DIR ? join(reporelayConfigDir(env), "reporelay-bridge-secret.txt") : defaultBridgeSecretFile(env);
}

export async function ensureQuickstartBridgeSecret(secretFile: string): Promise<string> {
  if (existsSync(secretFile)) {
    if (!statSync(secretFile).isFile()) throw new Error(`Bridge secret path is not a regular file: ${secretFile}`);
    const existing = (await readFile(secretFile, "utf8")).trim();
    if (existing.length < BRIDGE_SECRET_MIN_LENGTH) throw new Error(`Bridge secret at ${secretFile} is shorter than ${BRIDGE_SECRET_MIN_LENGTH} characters.`);
    return existing;
  }

  const secret = randomBytes(32).toString("base64url");
  await mkdir(dirname(secretFile), { recursive: true });
  await writeFile(secretFile, secret, { encoding: "utf8", mode: 0o600 });
  return secret;
}

function handoffTemplates(): Array<{ name: string; content: string }> {
  return [
    {
      name: "NEXT_TASK.md",
      content: "# Next task\r\n\r\nStatus: setup required\r\n\r\n## Objective\r\n\r\nReplace this placeholder with a user-authorized objective before implementation.\r\n",
    },
    {
      name: "REVIEW.md",
      content: "# Independent review\r\n\r\nStatus: pending\r\n\r\nThe AI reviewer writes its independent repository review here.\r\n",
    },
    {
      name: "RESULT.md",
      content: "# Implementation result\r\n\r\nStatus: pending\r\n\r\nThe local implementer writes implementation and validation evidence here.\r\n",
    },
    {
      name: "STATE.json",
      content: `${JSON.stringify({
        schemaVersion: 1,
        cycle: 0,
        phase: "setup_required",
        lastWriter: "onboarding",
        nextTaskStatus: "pending",
        resultStatus: "pending",
        reviewStatus: "pending",
        repositoryRevision: null,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\r\n`,
    },
  ];
}

function assertRegularFileIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!statSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
  return true;
}

export async function initializeHandoffFiles(repositoryRoot: string, options: { appendAgentInstructions?: boolean } = {}): Promise<HandoffInitResult> {
  const handoffDirectory = join(repositoryRoot, ".ai-handoff");
  await mkdir(handoffDirectory, { recursive: true });
  const created: string[] = [];
  const preserved: string[] = [];
  for (const template of handoffTemplates()) {
    const target = join(handoffDirectory, template.name);
    const relativePath = `.ai-handoff/${template.name}`;
    if (assertRegularFileIfPresent(target)) preserved.push(relativePath);
    else {
      await writeFile(target, template.content, { encoding: "utf8" });
      created.push(relativePath);
    }
  }

  const agentsPath = join(repositoryRoot, "AGENTS.md");
  if (!assertRegularFileIfPresent(agentsPath)) {
    await writeFile(agentsPath, `# Repository instructions\r\n\r\n${AGENTS_SECTION}\r\n`, { encoding: "utf8" });
    return { created, preserved, agentsAction: "create" };
  }

  const current = await readFile(agentsPath, "utf8");
  if (current.includes(AGENTS_MARKER)) return { created, preserved, agentsAction: "preserve-existing-marker" };
  if (!options.appendAgentInstructions) {
    throw new Error("AGENTS.md already exists. Re-run with --append-agent-instructions to back it up outside the repository and append the marked handoff section.");
  }

  const backupDirectory = await mkdtemp(join(tmpdir(), "reporelay-agents-backup-"));
  const agentsBackupPath = join(backupDirectory, "AGENTS.md");
  await copyFile(agentsPath, agentsBackupPath);
  await writeFile(agentsPath, `${current}\r\n${AGENTS_SECTION}\r\n`, { encoding: "utf8" });
  return { created, preserved, agentsAction: "backup-and-append", agentsBackupPath };
}

export function buildQuickstartEnv(input: {
  repositoryRoot: string;
  port: number;
  bridgeSecret: string;
  handoffWrites: boolean;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const configDirOverride = input.env?.REPORELAY_CONFIG_DIR;
  return {
    REPORELAY_HOST: "127.0.0.1",
    REPORELAY_PORT: String(input.port),
    REPORELAY_PUBLIC_BASE_URL: `http://127.0.0.1:${input.port}`,
    REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
    REPORELAY_ALLOWED_ROOTS: input.repositoryRoot,
    REPORELAY_HANDOFF_WRITES: input.handoffWrites ? "1" : "0",
    REPORELAY_BRIDGE_AUTH: "1",
    REPORELAY_BRIDGE_SECRET: input.bridgeSecret,
    REPORELAY_LOG_LEVEL: "info",
    REPORELAY_LOG_FORMAT: "json",
    REPORELAY_LOG_REQUESTS: "1",
    REPORELAY_LOG_TOOL_CALLS: "1",
    ...(configDirOverride ? { REPORELAY_CONFIG_DIR: configDirOverride } : {}),
  };
}

export async function verifyQuickstartBridge(input: { port: number; bridgeSecret: string; handoffWrites: boolean }): Promise<string[]> {
  const base = `http://127.0.0.1:${input.port}`;
  const health = await fetch(`${base}/healthz`);
  if (health.status !== 200) throw new Error(`Quickstart bridge health check failed with HTTP ${health.status}.`);
  await health.body?.cancel();

  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reporelay-quickstart", version: "1.0.0" } },
  });
  const requestHeaders = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", headers: requestHeaders, body: initializeBody });
  await unauthenticated.body?.cancel();
  if (unauthenticated.status !== 401) throw new Error(`Quickstart bridge accepted an unauthenticated MCP request (HTTP ${unauthenticated.status}).`);
  const wrongSecret = await fetch(`${base}/mcp`, { method: "POST", headers: { ...requestHeaders, [REPORELAY_BRIDGE_HEADER]: `${input.bridgeSecret}-wrong` }, body: initializeBody });
  await wrongSecret.body?.cancel();
  if (wrongSecret.status !== 401) throw new Error(`Quickstart bridge accepted an incorrect bridge secret (HTTP ${wrongSecret.status}).`);

  const client = new Client({ name: "reporelay-quickstart", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { [REPORELAY_BRIDGE_HEADER]: input.bridgeSecret } } }));
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = [...REVIEW_READ_TOOLS, ...(input.handoffWrites ? HANDOFF_WRITE_TOOLS : [])].sort();
    if (names.join(",") !== expected.join(",")) throw new Error(`Unexpected quickstart MCP tool surface: ${names.join(", ")}`);
    return names;
  } finally {
    await client.close();
  }
}

async function assertQuickstartPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolveCheck, rejectCheck) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settleFree = () => { socket.destroy(); resolveCheck(); };
    socket.once("connect", () => { socket.destroy(); rejectCheck(new Error(`Port ${port} is already in use. Stop the other listener or rerun quickstart with --port.`)); });
    socket.once("error", settleFree);
    socket.setTimeout(1_000, settleFree);
  });
}

export async function startQuickstart(options: QuickstartOptions): Promise<QuickstartRuntime> {
  const env = options.env ?? process.env;
  const port = options.port ?? 7676;
  const handoffWrites = options.handoffWrites ?? true;
  const secretFile = options.secretFile ?? defaultQuickstartSecretFile(env);
  const bridgeSecret = await ensureQuickstartBridgeSecret(secretFile);
  const config = loadConfig(buildQuickstartEnv({ repositoryRoot: resolve(options.repositoryRoot), port, bridgeSecret, handoffWrites, env }));
  await assertQuickstartPortAvailable(port);
  const handoffInit = await initializeHandoffFiles(config.bridgeWorkspaceRoot, { appendAgentInstructions: options.appendAgentInstructions });
  const running = createServer(config);
  const httpServer = await new Promise<Server>((resolveListen, rejectListen) => {
    const server = running.app.listen(config.port, config.host, () => resolveListen(server));
    server.once("error", rejectListen);
  }).catch(async (error) => {
    await running.close();
    throw error;
  });
  let tools: string[];
  try {
    tools = await verifyQuickstartBridge({ port: config.port, bridgeSecret, handoffWrites });
  } catch (error) {
    await shutdownHttpServer(httpServer, running.close).catch(() => undefined);
    throw error;
  }
  return {
    config,
    httpServer,
    stop: () => shutdownHttpServer(httpServer, running.close),
    summary: {
      repositoryRoot: config.bridgeWorkspaceRoot,
      localMcpUrl: `http://127.0.0.1:${config.port}/mcp`,
      bridgeSecretFile: secretFile,
      handoffWrites,
      tools,
      handoffInit,
    },
  };
}
