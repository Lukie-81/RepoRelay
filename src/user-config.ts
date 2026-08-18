import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expandHomePath } from "./roots.js";

const execFileAsync = promisify(execFile);

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

export function reporelayTunnelDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayConfigDir(env), "tunnel");
}

export function defaultTunnelConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayTunnelDir(env), "config.json");
}

export function defaultTunnelProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayTunnelDir(env), "profiles");
}

export function defaultTunnelProfileFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultTunnelProfileDir(env), "reporelay.yaml");
}

export function defaultTunnelSecretDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(reporelayTunnelDir(env), "secrets");
}

export function defaultTunnelRuntimeApiKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultTunnelSecretDir(env), "openai-runtime-api-key.txt");
}

/** Protects a file that contains a local credential for RepoRelay or tunnel-client. */
export async function protectUserSecretFile(secretFile: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(secretFile, 0o600);
    return;
  }

  const { stdout } = await execFileAsync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
  const identity = stdout.trim();
  if (!identity || /[\r\n]/.test(identity)) throw new Error("Could not resolve the current Windows identity for secret-file ACL protection.");

  await execFileAsync("icacls.exe", [
    secretFile,
    "/inheritance:r",
    "/remove:g",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
    "/grant:r",
    `${identity}:R`,
    "*S-1-5-18:R",
  ], { encoding: "utf8", windowsHide: true });
}
