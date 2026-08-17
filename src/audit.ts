import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  loadConfig,
  resolveApprovedRepositoryRoot,
  type ServerConfig,
} from "./config.js";
import { createServer, REPORELAY_BRIDGE_HEADER } from "./server.js";
import {
  type SecurityCheck,
  verifyBridgeRuntime,
} from "./security-verification.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { expandHomePath } from "./roots.js";
import { defaultQuickstartSecretFile } from "./quickstart.js";

export interface AuditOptions {
  repositoryRoot: string;
  bridgeSecret?: string;
  bridgeSecretError?: string;
  handoffWrites?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface AuditSecretOptions {
  secretFile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AuditSecretResult {
  secret?: string;
  error?: string;
}

export interface SecurityAuditReport {
  schemaVersion: 1;
  passed: boolean;
  repository: string;
  checks: SecurityCheck[];
}

export async function resolveAuditBridgeSecret(options: AuditSecretOptions = {}): Promise<AuditSecretResult> {
  const env = options.env ?? process.env;
  if (options.secretFile) return readSecretFile(resolve(expandHomePath(options.secretFile)));

  if (env.REPORELAY_BRIDGE_SECRET !== undefined) {
    const secret = env.REPORELAY_BRIDGE_SECRET.trim();
    return secret
      ? { secret }
      : { error: "REPORELAY_BRIDGE_SECRET is set but empty." };
  }

  const defaultSecretFile = defaultQuickstartSecretFile(env);
  if (existsSync(defaultSecretFile)) return readSecretFile(defaultSecretFile);
  return { error: "No bridge secret was found. Run quickstart first or pass --secret-file." };
}

export async function runSecurityAudit(options: AuditOptions): Promise<SecurityAuditReport> {
  const requestedRepository = resolve(expandHomePath(options.repositoryRoot));
  const checks: SecurityCheck[] = [];
  let repositoryRoot: string;

  try {
    repositoryRoot = resolveApprovedRepositoryRoot(options.repositoryRoot);
    const rootStats = await lstat(repositoryRoot);
    const filesystemRoot = parse(repositoryRoot).root;
    const operatorHome = resolve(homedir());
    checks.push(check("repository.exists", "repository", rootStats.isDirectory(), rootStats.isDirectory() ? `Approved root exists: ${repositoryRoot}.` : "Approved root is not a directory."));
    checks.push(check("repository.directory", "repository", rootStats.isDirectory(), "Approved root is a directory."));
    checks.push(check("repository.canonical", "repository", samePath(repositoryRoot, await realpathDirectory(repositoryRoot)), "Canonical approved root verified."));
    checks.push(check("repository.not_filesystem_root", "repository", !samePath(repositoryRoot, filesystemRoot), "Approved root is not a drive or filesystem root."));
    checks.push(check("repository.not_overly_broad", "repository", !isPathInsideOrEqual(operatorHome, repositoryRoot), "Approved root is narrower than the operator home directory."));
  } catch (error) {
    checks.push(failure("repository.root", "repository", `Approved repository validation failed: ${errorMessage(error)}.`));
    return createReport(requestedRepository, checks);
  }

  const env = options.env ?? process.env;
  checks.push(check(
    "bridge.loopback.configured",
    "bridge",
    (env.REPORELAY_HOST ?? "127.0.0.1") === "127.0.0.1",
    (env.REPORELAY_HOST ?? "127.0.0.1") === "127.0.0.1"
      ? "Bridge is configured for the 127.0.0.1 loopback interface."
      : "Bridge host is not the required 127.0.0.1 loopback interface.",
  ));
  checks.push(check(
    "bridge.auth.enabled",
    "bridge",
    (env.REPORELAY_BRIDGE_AUTH ?? "1") === "1",
    (env.REPORELAY_BRIDGE_AUTH ?? "1") === "1"
      ? "Bridge authentication is enabled."
      : "Bridge authentication is disabled or misconfigured.",
  ));

  if (options.bridgeSecretError || !options.bridgeSecret) {
    checks.push(failure("bridge.secret.available", "bridge", options.bridgeSecretError ?? "Bridge secret is unavailable."));
    checks.push(failure("bridge.runtime", "bridge", "Live bridge checks were not run because authentication material is unavailable."));
    checks.push(failure("tool_surface.runtime", "tool_surface", "MCP tool-surface checks were not run because the bridge could not start safely."));
    return createReport(repositoryRoot, checks);
  }

  const auditEnv = buildAuditEnvironment(repositoryRoot, options.bridgeSecret, env, options.handoffWrites);
  let config: ServerConfig;
  try {
    config = loadConfig(auditEnv);
  } catch (error) {
    checks.push(failure("bridge.configuration", "bridge", `RepoRelay configuration validation failed: ${errorMessage(error)}.`));
    return createReport(repositoryRoot, checks);
  }

  checks.push(check("bridge.secret.valid", "bridge", config.bridgeSecret.length >= 32, "Bridge secret meets the minimum length requirement."));
  checks.push(check("bridge.root.bound", "bridge", samePath(config.bridgeWorkspaceRoot, repositoryRoot), "Bridge is bound to the approved canonical repository."));
  checks.push(check("bridge.allowed_hosts.explicit", "bridge", config.allowedHosts.length > 0 && !config.allowedHosts.includes("*"), "Host allowlist is explicit and wildcard-free."));

  const running = createServer(config);
  let httpServer: Server | undefined;
  try {
    httpServer = await listenEphemeral(running, config.host);
    const address = httpServer.address();
    const loopback = typeof address !== "string" && address !== null && address.address === "127.0.0.1";
    checks.push(check(
      "bridge.listener.loopback",
      "bridge",
      loopback,
      loopback ? "Live audit listener is bound only to 127.0.0.1." : "Live audit listener is not bound only to 127.0.0.1.",
    ));
    if (typeof address !== "string" && address !== null) {
      checks.push(...await verifyBridgeRuntime({
        baseUrl: `http://127.0.0.1:${address.port}`,
        bridgeSecret: options.bridgeSecret,
        handoffWrites: config.handoffWritesEnabled,
        workspacePath: repositoryRoot,
        clientName: "reporelay-audit",
      }));
    } else {
      checks.push(failure("bridge.runtime", "bridge", "Live audit listener did not expose a usable loopback address."));
      checks.push(failure("tool_surface.runtime", "tool_surface", "MCP tool-surface checks could not run without a live listener."));
    }
  } catch (error) {
    checks.push(failure("bridge.runtime", "bridge", `Live bridge audit could not start: ${errorMessage(error)}.`));
    checks.push(failure("tool_surface.runtime", "tool_surface", "MCP tool-surface checks could not run because the live bridge did not start."));
  } finally {
    if (httpServer) await shutdownHttpServer(httpServer, running.close).catch(() => undefined);
    else await running.close().catch(() => undefined);
  }

  checks.push(...await verifyAdversarialFixture(config.handoffWritesEnabled));
  return createReport(repositoryRoot, checks);
}

export function formatSecurityAudit(report: SecurityAuditReport): string {
  const labels: Record<SecurityCheck["area"], string> = {
    repository: "Repository",
    bridge: "Bridge",
    tool_surface: "Tool surface",
    containment: "Containment",
    handoff: "Handoffs",
  };
  const lines = ["RepoRelay Security Audit", ""];
  const areaOrder: SecurityCheck["area"][] = ["repository", "bridge", "tool_surface", "containment", "handoff"];
  for (const area of areaOrder) {
    const areaChecks = report.checks.filter((item) => item.area === area);
    if (areaChecks.length === 0) continue;
    if (lines.at(-1) !== "") lines.push("");
    lines.push(labels[area]);
    for (const item of areaChecks) {
      const symbol = item.status === "pass" ? "✓" : item.status === "not_applicable" ? "—" : "✗";
      lines.push(`${symbol} ${item.message}`);
    }
  }
  lines.push("", `RESULT: ${report.passed ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

function buildAuditEnvironment(repositoryRoot: string, bridgeSecret: string, env: NodeJS.ProcessEnv, handoffWrites?: boolean): NodeJS.ProcessEnv {
  const port = env.REPORELAY_PORT?.trim() || "7676";
  return {
    ...env,
    REPORELAY_HOST: env.REPORELAY_HOST ?? "127.0.0.1",
    REPORELAY_PORT: port,
    REPORELAY_ALLOWED_ROOTS: repositoryRoot,
    REPORELAY_BRIDGE_AUTH: env.REPORELAY_BRIDGE_AUTH ?? "1",
    REPORELAY_BRIDGE_SECRET: bridgeSecret,
    REPORELAY_PUBLIC_BASE_URL: env.REPORELAY_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
    REPORELAY_ALLOWED_HOSTS: env.REPORELAY_ALLOWED_HOSTS ?? "127.0.0.1",
    REPORELAY_HANDOFF_WRITES: handoffWrites === undefined ? env.REPORELAY_HANDOFF_WRITES ?? "1" : handoffWrites ? "1" : "0",
    REPORELAY_LOG_LEVEL: "silent",
    REPORELAY_LOG_REQUESTS: "0",
    REPORELAY_LOG_TOOL_CALLS: "0",
  };
}

async function verifyAdversarialFixture(handoffWrites: boolean): Promise<SecurityCheck[]> {
  const checks: SecurityCheck[] = [];
  let runRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  const outsideMarker = `outside-${randomUUID()}`;
  const fixtureSecret = `reporelay-audit-${randomUUID()}-${randomUUID()}`;

  try {
    runRoot = await mkdtemp(join(tmpdir(), "reporelay-audit-fixture-"));
    workspaceRoot = join(runRoot, "workspace");
    outsideRoot = join(runRoot, "outside");
    await mkdir(join(workspaceRoot, ".ai-handoff"), { recursive: true });
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, ".ssh"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "README.md"), "inside marker\n", "utf8");
    await writeFile(join(workspaceRoot, ".env"), "environment secret\n", "utf8");
    await writeFile(join(workspaceRoot, ".git", "config"), "git metadata\n", "utf8");
    await writeFile(join(workspaceRoot, ".ssh", "id_ed25519"), "private key\n", "utf8");
    await writeFile(join(workspaceRoot, "private.pem"), "private key\n", "utf8");
    await writeFile(join(workspaceRoot, "credentials.json"), "credentials\n", "utf8");
    await writeFile(join(outsideRoot, "outside.txt"), outsideMarker, "utf8");
    await writeFile(join(workspaceRoot, ".ai-handoff", "NEXT_TASK.md"), "next\n", "utf8");
    await writeFile(join(workspaceRoot, ".ai-handoff", "REVIEW.md"), "review\n", "utf8");
    await writeFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "implementer result\n", "utf8");
    await writeFile(join(workspaceRoot, ".ai-handoff", "STATE.json"), "{}\n", "utf8");
    await symlink(outsideRoot, join(workspaceRoot, "redirect"), process.platform === "win32" ? "junction" : "dir");
    await link(join(outsideRoot, "outside.txt"), join(workspaceRoot, "hard-link.txt"));
  } catch (error) {
    checks.push(failure("containment.fixture", "containment", `Adversarial containment fixture could not be created: ${errorMessage(error)}.`));
    return checks;
  }

  let config: ServerConfig;
  try {
    config = loadConfig({
      REPORELAY_ALLOWED_ROOTS: workspaceRoot,
      REPORELAY_BRIDGE_SECRET: fixtureSecret,
      REPORELAY_BRIDGE_AUTH: "1",
      REPORELAY_HANDOFF_WRITES: handoffWrites ? "1" : "0",
      REPORELAY_ALLOWED_HOSTS: "127.0.0.1",
      REPORELAY_LOG_LEVEL: "silent",
      REPORELAY_LOG_REQUESTS: "0",
      REPORELAY_LOG_TOOL_CALLS: "0",
    });
  } catch (error) {
    checks.push(failure("containment.configuration", "containment", `Adversarial fixture configuration failed: ${errorMessage(error)}.`));
    return checks;
  }
  const running = createServer(config);
  let httpServer: Server | undefined;
  let client: Client | undefined;
  try {
    httpServer = await listenEphemeral(running, config.host);
    const address = httpServer.address();
    if (typeof address === "string" || address === null) throw new Error("Fixture listener did not expose a TCP address.");
    client = new Client({ name: "reporelay-audit-fixture", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { [REPORELAY_BRIDGE_HEADER]: fixtureSecret } },
    }));
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    if (opened.isError === true) throw new Error("Fixture workspace could not be opened through MCP.");
    const workspaceId = readWorkspaceId(opened);

    const safeRead = await client.callTool({ name: "read_file", arguments: { workspaceId, path: "README.md" } });
    checks.push(check("containment.allowed_read", "containment", safeRead.isError !== true && resultText(safeRead).includes("inside marker"), "Allowed repository reads succeed through MCP."));

    const sensitivePaths = [".env", ".git/config", ".ssh/id_ed25519", "private.pem", "credentials.json"];
    const sensitiveResults = await Promise.all(sensitivePaths.map((path) => rejectedToolCall(client as Client, "read_file", { workspaceId, path })));
    checks.push(check("containment.sensitive_paths", "containment", sensitiveResults.every(Boolean), "Sensitive files and credential paths are blocked."));

    const parentRejected = await rejectedToolCall(client, "read_file", { workspaceId, path: "../outside/outside.txt" });
    checks.push(check("containment.parent_traversal", "containment", parentRejected, "Parent traversal is blocked."));

    const absoluteRejected = await rejectedToolCall(client, "read_file", { workspaceId, path: join(outsideRoot, "outside.txt") });
    checks.push(check("containment.absolute_outside", "containment", absoluteRejected, "Absolute outside-root paths are blocked."));

    const redirectRejected = await rejectedToolCall(client, "read_file", { workspaceId, path: "redirect/outside.txt" });
    checks.push(check("containment.symlink_junction", "containment", redirectRejected, process.platform === "win32" ? "Junction escapes are blocked." : "Symlink escapes are blocked."));

    const hardLinkRejected = await rejectedToolCall(client, "read_file", { workspaceId, path: "hard-link.txt" });
    checks.push(check("containment.hard_link", "containment", hardLinkRejected, "Hard-linked file bypasses are blocked."));

    const search = await client.callTool({ name: "search_files", arguments: { workspaceId, query: outsideMarker } });
    checks.push(check("containment.search_outside", "containment", search.isError !== true && !resultText(search).includes(outsideMarker), "Search does not cross blocked links or reveal outside-root content."));

    const listed = await client.callTool({ name: "list_files", arguments: { workspaceId, path: "." } });
    checks.push(check("containment.list_blocked_links", "containment", listed.isError !== true && resultText(listed).includes("blocked-link\tredirect"), "Directory listing reports redirecting entries as blocked."));

    const genericWriteRejected = await rejectedToolCall(client, "write_file", { workspaceId, path: "created.txt", content: "must not write" });
    checks.push(check("handoff.no_generic_write", "handoff", genericWriteRejected, "Generic file writes are unavailable."));

    const tools = await client.listTools();
    const writerSchemas = tools.tools
      .filter((tool) => ["write_next_task", "write_review", "update_handoff_state"].includes(tool.name))
      .map((tool) => Object.keys(tool.inputSchema.properties ?? {}).sort().join(","));
    const fixedSchema = !handoffWrites || writerSchemas.length === 3 && writerSchemas.every((schema) => schema === "content,workspaceId");
    checks.push(check("handoff.fixed_destinations", "handoff", fixedSchema, handoffWrites ? "Handoff writers expose fixed destinations without a path parameter." : "Handoff writers are disabled; no destination is exposed."));

    const resultBefore = await readFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "utf8");
    if (handoffWrites) {
      const next = await client.callTool({ name: "write_next_task", arguments: { workspaceId, content: "updated task\n", destination: ".ai-handoff/RESULT.md" } });
      const review = await client.callTool({ name: "write_review", arguments: { workspaceId, content: "updated review\n", path: ".ai-handoff/RESULT.md" } });
      const state = await client.callTool({ name: "update_handoff_state", arguments: { workspaceId, content: '{"phase":"ready_for_review"}', filename: "outside.json" } });
      const resultAfter = await readFile(join(workspaceRoot, ".ai-handoff", "RESULT.md"), "utf8");
      const fixedWritesSucceeded = next.isError !== true && review.isError !== true && state.isError !== true;
      checks.push(check("handoff.fixed_writes", "handoff", fixedWritesSucceeded, "Permitted handoff writers update only their fixed pre-existing targets."));
      checks.push(check("handoff.agent_result_protected", "handoff", resultAfter === resultBefore, "The implementer-owned RESULT.md remains unchanged by MCP handoff writes."));
    } else {
      checks.push(check("handoff.agent_result_protected", "handoff", true, "The implementer-owned RESULT.md is protected because handoff writes are disabled."));
    }
  } catch (error) {
    checks.push(failure("containment.integration", "containment", `Adversarial MCP fixture checks could not complete: ${errorMessage(error)}.`));
  } finally {
    await client?.close().catch(() => undefined);
    if (httpServer) await shutdownHttpServer(httpServer, running.close).catch(() => undefined);
    else await running.close().catch(() => undefined);
  }
  return checks;
}

async function listenEphemeral(running: ReturnType<typeof createServer>, host: string): Promise<Server> {
  return new Promise<Server>((resolveServer, reject) => {
    const server = running.app.listen(0, host, () => resolveServer(server));
    server.once("error", reject);
  });
}

async function readSecretFile(path: string): Promise<AuditSecretResult> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return { error: "Bridge secret path is not a regular non-link file." };
    const secret = (await readFile(path, "utf8")).trim();
    return secret ? { secret } : { error: "Bridge secret file is empty." };
  } catch {
    return { error: "Bridge secret file could not be read." };
  }
}

async function realpathDirectory(path: string): Promise<string> {
  return realpath(path);
}

function check(id: string, area: SecurityCheck["area"], passed: boolean, message: string): SecurityCheck {
  return { id, area, status: passed ? "pass" : "fail", message };
}

function failure(id: string, area: SecurityCheck["area"], message: string): SecurityCheck {
  return { id, area, status: "fail", message };
}

function createReport(repository: string, checks: SecurityCheck[]): SecurityAuditReport {
  return {
    schemaVersion: 1,
    passed: checks.every((item) => item.status !== "fail"),
    repository,
    checks,
  };
}

function isPathInsideOrEqual(candidate: string, parent: string): boolean {
  const relationship = relative(resolve(parent), resolve(candidate));
  return relationship === ""
    || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function readWorkspaceId(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const structured = result.structuredContent;
  const workspaceId = structured && typeof structured === "object" && "workspaceId" in structured
    ? structured.workspaceId
    : undefined;
  if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Fixture MCP open response did not contain a workspace ID.");
  return workspaceId;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && "result" in structured && typeof structured.result === "string") {
    return structured.result;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item: unknown): item is { type: "text"; text: string } => (
      typeof item === "object"
      && item !== null
      && "type" in item
      && item.type === "text"
      && "text" in item
      && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
}

async function rejectedToolCall(client: Client, name: string, arguments_: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await client.callTool({ name, arguments: arguments_ });
    return result.isError === true;
  } catch {
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
