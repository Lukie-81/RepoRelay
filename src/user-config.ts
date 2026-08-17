import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export function reporelayConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA;
  const defaultDirectory = localAppData
    ? join(localAppData, "RepoRelay")
    : join(homedir(), ".reporelay");
  return resolve(expandHomePath(env.REPORELAY_CONFIG_DIR ?? defaultDirectory));
}

export function defaultBridgeSecretFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayConfigDir(env), "reporelay-bridge-secret.txt");
}
