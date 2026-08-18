import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import * as z from "zod/v4";
import { assertRepoRelaySafety, loadConfig, type ServerConfig } from "./config.js";
import { logEvent, requestIp, requestPath, sessionIdPrefix } from "./logger.js";
import { McpSessionRegistry, type McpSessionCloseResult } from "./mcp-sessions.js";
import { listReviewDirectory, readReviewTextFile, searchReviewFiles, writeHandoffDocument } from "./review-files.js";
import { WorkspaceRegistry } from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const MCP_BODY_LIMIT = "2mb";
export const REPORELAY_BRIDGE_HEADER = "X-RepoRelay-Bridge-Secret";

interface ToolTextResult extends Record<string, unknown> {
  content: [{ type: "text"; text: string }];
  structuredContent: { result: string };
}

function textResult(result: string): ToolTextResult {
  return {
    content: [{ type: "text", text: result }],
    structuredContent: { result },
  };
}

function toolOutputSchema(): z.ZodRawShape {
  return { result: z.string() };
}

export function registerRepoRelayTools(
  server: McpServer,
  config: Pick<ServerConfig, "handoffWritesEnabled">,
  workspaces: WorkspaceRegistry,
): void {
  server.registerTool(
    "open_workspace",
    {
      title: "Open approved repository",
      description: "Open an existing repository inside RepoRelay's one explicitly approved root.",
      inputSchema: {
        path: z.string().describe("Existing repository path inside the approved root."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        result: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path }) => {
      const { workspace } = await workspaces.openWorkspace(path);
      const result = `Opened approved repository ${workspace.root}.`;
      return {
        content: [{ type: "text", text: result }],
        structuredContent: { workspaceId: workspace.id, root: workspace.root, result },
      };
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List repository files",
      description: "List a real directory inside the opened repository. Links and junctions are reported as blocked.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().optional().describe("Repository-relative directory path. Defaults to the root."),
      },
      outputSchema: toolOutputSchema(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspaceId, path }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const entries = await listReviewDirectory(workspace.root, path ?? ".");
      return textResult(entries.map((entry) => `${entry.type}\t${entry.path}`).join("\n") || "Directory is empty.");
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read repository file",
      description: "Read one regular, non-sensitive file whose canonical target remains inside the opened repository.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().describe("Repository-relative file path."),
      },
      outputSchema: toolOutputSchema(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspaceId, path }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return textResult(await readReviewTextFile(workspace.root, path));
    },
  );

  server.registerTool(
    "search_files",
    {
      title: "Search repository files",
      description: "Search regular, non-sensitive files inside the opened repository using a case-insensitive literal query.",
      inputSchema: {
        workspaceId: z.string(),
        query: z.string().min(1).max(1_000),
        path: z.string().optional().describe("Optional repository-relative file or directory scope."),
        maxResults: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: toolOutputSchema(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspaceId, query, path, maxResults }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const matches = await searchReviewFiles(workspace.root, query, path ?? ".", maxResults);
      return textResult(matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches.");
    },
  );

  if (!config.handoffWritesEnabled) return;

  const registerFixedWriter = (
    name: "write_next_task" | "write_review" | "update_handoff_state",
    title: string,
    description: string,
    document: "nextTask" | "review" | "state",
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          workspaceId: z.string(),
          content: z.string().describe("Complete replacement content. The destination is fixed by the tool."),
        },
        outputSchema: toolOutputSchema(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ workspaceId, content }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return textResult(`Updated ${await writeHandoffDocument(workspace.root, document, content)}.`);
      },
    );
  };

  registerFixedWriter(
    "write_next_task",
    "Write next handoff task",
    "Replace only .ai-handoff/NEXT_TASK.md. This tool has no destination-path parameter.",
    "nextTask",
  );
  registerFixedWriter(
    "write_review",
    "Write independent handoff review",
    "Replace only .ai-handoff/REVIEW.md. This tool has no destination-path parameter.",
    "review",
  );
  registerFixedWriter(
    "update_handoff_state",
    "Update handoff state",
    "Replace only .ai-handoff/STATE.json with a valid JSON object. This tool has no destination-path parameter.",
    "state",
  );
}

function createMcpServer(config: ServerConfig, workspaces: WorkspaceRegistry): McpServer {
  const server = new McpServer(
    {
      name: "reporelay",
      title: "RepoRelay",
      version: "1.2.5",
      description: "A local-first MCP bridge for constrained repository review and fixed handoff coordination.",
    },
    {
      instructions: config.handoffWritesEnabled
        ? "Use RepoRelay to inspect the one approved repository. Call open_workspace once, then use list_files, read_file, and search_files. The only writes available are fixed-target updates to NEXT_TASK.md, REVIEW.md, and STATE.json under .ai-handoff; there is no shell, process, Git, edit, patch, artifact, worktree, skill, subagent, or unrestricted filesystem capability."
        : "Use RepoRelay to inspect the one approved repository. Call open_workspace once, then use list_files, read_file, and search_files. This connection is read-only; there is no shell, process, Git, edit, patch, artifact, worktree, skill, subagent, or unrestricted filesystem capability.",
    },
  );
  registerRepoRelayTools(server, config, workspaces);
  return server;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function mcpBodyParserErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const type = "type" in error ? error.type : undefined;
  if (type === "entity.too.large") return 413;
  if (type === "entity.parse.failed" || (error instanceof SyntaxError && "body" in error)) return 400;
  return undefined;
}

function requestLogFields(req: Request): Record<string, unknown> {
  return {
    ip: requestIp(req),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    contentLength: req.header("content-length"),
  };
}

function logSessionCloseResults(config: ServerConfig, reason: "idle_timeout" | "server_shutdown", results: McpSessionCloseResult[]): void {
  for (const result of results) {
    logEvent(config.logging, result.error ? "warn" : "info", result.error ? "mcp_session_close_failed" : "mcp_session_closed", {
      reason,
      sessionIdPrefix: sessionIdPrefix(result.sessionId),
      ...(result.error ? { error: result.error instanceof Error ? result.error.message : String(result.error) } : {}),
    });
  }
}

export interface RunningServer {
  app: Express;
  config: ServerConfig;
  close(): Promise<void>;
}

export function createServer(config = loadConfig()): RunningServer {
  assertRepoRelaySafety(config);
  const allowedHosts = Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = express();
  app.use(hostHeaderValidation(allowedHosts));

  const transports = new McpSessionRegistry<Transport>();
  const workspaces = new WorkspaceRegistry(config);
  const cleanupTimer = setInterval(() => {
    void transports.closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS).then((results) => {
      logSessionCloseResults(config, "idle_timeout", results);
    });
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.on("finish", () => {
      if (!config.logging.requests) return;
      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path: requestPath(req),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req),
      });
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "reporelay" });
  });

  const authenticateBridge = (req: Request, res: Response, next: NextFunction) => {
    const headerCount = req.rawHeaders.reduce((count, name, index) => (
      index % 2 === 0 && name.toLowerCase() === REPORELAY_BRIDGE_HEADER.toLowerCase() ? count + 1 : count
    ), 0);
    const supplied = req.get(REPORELAY_BRIDGE_HEADER);
    const suppliedDigest = createHash("sha256").update(supplied ?? "", "utf8").digest();
    const expectedDigest = createHash("sha256").update(config.bridgeSecret, "utf8").digest();
    if (headerCount !== 1 || !supplied || !timingSafeEqual(suppliedDigest, expectedDigest)) {
      logEvent(config.logging, "warn", "bridge_auth_denied", {
        requestId: res.locals.requestId as string | undefined,
        method: req.method,
        path: requestPath(req),
        reason: headerCount === 1 ? "invalid_bridge_secret" : "invalid_bridge_header_count",
        ...requestLogFields(req),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }
    next();
  };

  const parseMcpBody = express.json({ limit: MCP_BODY_LIMIT });
  app.all("/mcp", authenticateBridge, parseMcpBody, async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    try {
      let transport: Transport | undefined;
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req),
            });
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };
        const server = createMcpServer(config, workspaces);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    const status = mcpBodyParserErrorStatus(error);
    if (status === undefined || req.path !== "/mcp" || res.headersSent) {
      next(error);
      return;
    }
    logEvent(config.logging, "warn", "mcp_request_body_rejected", {
      requestId: res.locals.requestId as string | undefined,
      status,
      ...requestLogFields(req),
    });
    sendJsonRpcError(res, status, status === 413 ? -32000 : -32700, status === 413 ? "Request body too large" : "Parse error");
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(cleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults(config, "server_shutdown", results);
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  return (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]));
}

if (await isMainModule()) {
  const running = createServer();
  const httpServer = running.app.listen(running.config.port, running.config.host, () => {
    console.log(`reporelay listening on http://${running.config.host}:${running.config.port}/mcp`);
    console.log(`approved repository: ${running.config.bridgeWorkspaceRoot}`);
    console.log(`handoff writes: ${running.config.handoffWritesEnabled ? "enabled" : "disabled"}`);
  });
  const shutdown = () => {
    void new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    }).then(() => running.close()).then(() => process.exit(0)).catch((error) => {
      console.error("reporelay shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
