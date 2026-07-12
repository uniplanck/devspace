import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-internal-mcp-test-"));
const internalSecret = "internal-mcp-secret-that-is-long-enough";
const running = createServer(loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_INTERNAL_MCP_SECRET: internalSecret,
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:17676",
  DEVSPACE_LOG_LEVEL: "silent",
}));
const httpServer = running.app.listen(0, "127.0.0.1");

try {
  await once(httpServer, "listening");
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const missingSecret = await fetch(`${origin}/mcp-internal`, { method: "POST" });
  assert.equal(missingSecret.status, 404);

  const publicOauthRoute = await fetch(`${origin}/mcp`, { method: "POST" });
  assert.equal(publicOauthRoute.status, 401);

  const initialize = await fetch(`${origin}/mcp-internal`, {
    method: "POST",
    headers: {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "x-devspace-internal-key": internalSecret,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "internal-mcp-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialize.status, 200);
  assert.match(await initialize.text(), /"serverInfo"/);
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  running.close();
  rmSync(root, { recursive: true, force: true });
}
