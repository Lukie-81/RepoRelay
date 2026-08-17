import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REPORELAY_BRIDGE_HEADER } from "./server.js";

export const REVIEW_READ_TOOLS = ["list_files", "open_workspace", "read_file", "search_files"] as const;
export const HANDOFF_WRITE_TOOLS = ["update_handoff_state", "write_next_task", "write_review"] as const;

export type SecurityCheckStatus = "pass" | "fail" | "not_applicable";

export interface SecurityCheck {
  id: string;
  area: "repository" | "bridge" | "tool_surface" | "containment" | "handoff";
  status: SecurityCheckStatus;
  message: string;
}

export interface BridgeRuntimeVerificationInput {
  baseUrl: string;
  bridgeSecret: string;
  handoffWrites: boolean;
  workspacePath?: string;
  clientName?: string;
}

export function expectedRepoRelayTools(handoffWrites: boolean): string[] {
  return [...REVIEW_READ_TOOLS, ...(handoffWrites ? HANDOFF_WRITE_TOOLS : [])].sort();
}

export function assertSecurityChecksPassed(checks: readonly SecurityCheck[], label: string): void {
  const failures = checks.filter((check) => check.status !== "pass");
  if (failures.length === 0) return;
  throw new Error(`${label} failed: ${failures.map((check) => `${check.id}: ${check.message}`).join("; ")}`);
}

export async function verifyBridgeRuntime(input: BridgeRuntimeVerificationInput): Promise<SecurityCheck[]> {
  const checks: SecurityCheck[] = [];
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: input.clientName ?? "reporelay-security-check", version: "1.0.0" },
    },
  });
  const requestHeaders = { accept: "application/json, text/event-stream", "content-type": "application/json" };

  try {
    const response = await fetch(`${baseUrl}/healthz`);
    await response.body?.cancel();
    checks.push({
      id: "bridge.health",
      area: "bridge",
      status: response.status === 200 ? "pass" : "fail",
      message: response.status === 200 ? "Bridge health endpoint responded successfully." : `Bridge health endpoint returned HTTP ${response.status}.`,
    });
  } catch (error) {
    checks.push({
      id: "bridge.health",
      area: "bridge",
      status: "fail",
      message: `Bridge health check could not complete: ${errorMessage(error)}.`,
    });
  }

  checks.push(await verifyAuthenticationRequest({
    id: "bridge.auth.missing",
    message: "Unauthenticated MCP requests are rejected.",
    expectedStatus: 401,
    url: `${baseUrl}/mcp`,
    headers: requestHeaders,
    body: initializeBody,
  }));
  checks.push(await verifyAuthenticationRequest({
    id: "bridge.auth.invalid",
    message: "Incorrect bridge secrets are rejected.",
    expectedStatus: 401,
    url: `${baseUrl}/mcp`,
    headers: { ...requestHeaders, [REPORELAY_BRIDGE_HEADER]: `${input.bridgeSecret}-invalid` },
    body: initializeBody,
  }));
  const duplicateHeaders = new Headers(requestHeaders);
  duplicateHeaders.set(REPORELAY_BRIDGE_HEADER, input.bridgeSecret);
  duplicateHeaders.append(REPORELAY_BRIDGE_HEADER, input.bridgeSecret);
  checks.push(await verifyAuthenticationRequest({
    id: "bridge.auth.duplicate",
    message: "Duplicate bridge-secret headers are rejected.",
    expectedStatus: 401,
    url: `${baseUrl}/mcp`,
    headers: duplicateHeaders,
    body: initializeBody,
  }));

  const client = new Client({
    name: input.clientName ?? "reporelay-security-check",
    version: "1.0.0",
  });
  let connected = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { [REPORELAY_BRIDGE_HEADER]: input.bridgeSecret } },
    }));
    connected = true;

    if (input.workspacePath !== undefined) {
      try {
        const opened = await client.callTool({
          name: "open_workspace",
          arguments: { path: input.workspacePath },
        });
        const succeeded = opened.isError !== true;
        checks.push({
          id: "repository.open",
          area: "repository",
          status: succeeded ? "pass" : "fail",
          message: succeeded ? "Approved repository opened through MCP." : "Approved repository could not be opened through MCP.",
        });
      } catch (error) {
        checks.push({
          id: "repository.open",
          area: "repository",
          status: "fail",
          message: `Approved repository MCP open failed: ${errorMessage(error)}.`,
        });
      }
    }

    try {
      const listed = await client.listTools();
      const actualNames = listed.tools.map((tool) => tool.name).sort();
      const expectedNames = expectedRepoRelayTools(input.handoffWrites);
      const exact = actualNames.join(",") === expectedNames.join(",");
      checks.push({
        id: "tool_surface.expected",
        area: "tool_surface",
        status: exact ? "pass" : "fail",
        message: exact
          ? `MCP exposes exactly ${expectedNames.length} approved tools.`
          : `Unexpected MCP tool surface: ${actualNames.join(", ") || "none"}.`,
      });

      const advertised = listed.tools
        .map((tool) => `${tool.name} ${tool.description ?? ""} ${JSON.stringify(tool.inputSchema ?? {})}`)
        .join("\n");
      const dangerousCapability = /(^|[^a-z])(shell|command execution|process execution|git operations?|arbitrary (?:file )?writes?|patch(?:ing)?|delete(?:s|ion)?|artifact(?:s)?|worktree|skill(?:s)?|subagent(?:s)?)([^a-z]|$)/i.test(advertised);
      checks.push({
        id: "tool_surface.no_dangerous_capabilities",
        area: "tool_surface",
        status: dangerousCapability ? "fail" : "pass",
        message: dangerousCapability
          ? "A listed tool advertises a prohibited execution, Git, or arbitrary-mutation capability."
          : "No listed tool advertises shell, Git, process, or arbitrary-mutation capability.",
      });
    } catch (error) {
      checks.push({
        id: "tool_surface.expected",
        area: "tool_surface",
        status: "fail",
        message: `MCP tool discovery failed: ${errorMessage(error)}.`,
      });
      checks.push({
        id: "tool_surface.no_dangerous_capabilities",
        area: "tool_surface",
        status: "fail",
        message: "MCP tool capabilities could not be inspected safely.",
      });
    }
  } catch (error) {
    checks.push({
      id: "tool_surface.connection",
      area: "tool_surface",
      status: "fail",
      message: `Authenticated MCP connection failed: ${errorMessage(error)}.`,
    });
    checks.push({
      id: "tool_surface.expected",
      area: "tool_surface",
      status: "fail",
      message: "MCP tool surface could not be verified.",
    });
    checks.push({
      id: "tool_surface.no_dangerous_capabilities",
      area: "tool_surface",
      status: "fail",
      message: "MCP tool capabilities could not be inspected safely.",
    });
  } finally {
    if (connected) await client.close().catch(() => undefined);
  }

  return checks;
}

async function verifyAuthenticationRequest(input: {
  id: string;
  message: string;
  expectedStatus: number;
  url: string;
  headers: HeadersInit;
  body: string;
}): Promise<SecurityCheck> {
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
    });
    await response.body?.cancel();
    return {
      id: input.id,
      area: "bridge",
      status: response.status === input.expectedStatus ? "pass" : "fail",
      message: response.status === input.expectedStatus
        ? input.message
        : `Expected HTTP ${input.expectedStatus}, received HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      id: input.id,
      area: "bridge",
      status: "fail",
      message: `Authentication check could not complete: ${errorMessage(error)}.`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
