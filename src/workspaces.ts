import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { resolveReviewWorkspaceRoot } from "./review-files.js";

export interface Workspace {
  id: string;
  root: string;
}

export interface WorkspaceContext {
  workspace: Workspace;
}

export interface OpenWorkspaceInput {
  path: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: Pick<ServerConfig, "allowedRoots">) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const path = typeof input === "string" ? input : input.path;
    const root = await resolveReviewWorkspaceRoot(path, this.config.allowedRoots);
    const workspace: Workspace = { id: `ws_${randomUUID()}`, root };
    this.workspaces.set(workspace.id, workspace);
    return { workspace };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }
    return workspace;
  }
}
