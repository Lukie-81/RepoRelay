import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-auth-order-test-"));
const running = createServer(loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  HOST: "127.0.0.1",
  DEVSPACE_ALLOWED_HOSTS: "127.0.0.1",
  DEVSPACE_PORT: "3003",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:3003",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_SKILLS: "0",
}));

let httpServer: Server | undefined;
try {
  httpServer = await new Promise<Server>((resolve, reject) => {
    const server = running.app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const oversizedMalformedJson = `{"payload":"${"x".repeat(256 * 1024)}`;

  const mcpResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedMalformedJson,
  });
  assert.equal(mcpResponse.status, 401);

  const slashResponse = await fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedMalformedJson,
  });
  assert.equal(slashResponse.status, 401);

} finally {
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((error) => error ? reject(error) : resolve());
    });
  }
  await running.close();
  await rm(root, { recursive: true, force: true });
}
