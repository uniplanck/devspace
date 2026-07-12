import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mode = process.env.GAG_E2E_MODE ?? "full";
const baseUrl = process.env.GAG_E2E_BASE_URL ?? "http://127.0.0.1:7676";
const defaultConfigDir = process.platform === "linux" && process.env.HOME
  ? `${process.env.HOME}/.devspace`
  : undefined;
const persistedConfigPath = defaultConfigDir ? `${defaultConfigDir}/config.json` : undefined;
const persistedConfig = persistedConfigPath && existsSync(persistedConfigPath)
  ? JSON.parse(readFileSync(persistedConfigPath, "utf8"))
  : {};
const publicBaseUrl = process.env.GAG_E2E_PUBLIC_BASE_URL ?? persistedConfig.publicBaseUrl ?? baseUrl;
const workspacePath = process.env.GAG_E2E_WORKSPACE ?? "/home/ubuntu/GPT-Agent";

function networkUrl(input) {
  const requested = new URL(input, baseUrl);
  const network = new URL(baseUrl);
  network.pathname = requested.pathname;
  network.search = requested.search;
  return network;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function decodeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function resultText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function assertToolResult(label, result) {
  if (result.isError) {
    throw new Error(`${label} failed: ${resultText(result).slice(0, 800)}`);
  }
  return result;
}

const networkMcpUrl = `${baseUrl}/mcp`;
const resourceMcpUrl = `${publicBaseUrl}/mcp`;
const metadata = await fetchJson(`${baseUrl}/.well-known/oauth-authorization-server`);
const registration = await fetchJson(networkUrl(metadata.registration_endpoint), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "gag-ec2-e2e",
    redirect_uris: ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "http://127.0.0.1/callback";
const authorizationUrl = new URL(metadata.authorization_endpoint);
authorizationUrl.searchParams.set("response_type", "code");
authorizationUrl.searchParams.set("client_id", registration.client_id);
authorizationUrl.searchParams.set("redirect_uri", redirectUri);
authorizationUrl.searchParams.set("scope", "devspace");
authorizationUrl.searchParams.set("state", "gag-ec2-e2e");
authorizationUrl.searchParams.set("code_challenge", challenge);
authorizationUrl.searchParams.set("code_challenge_method", "S256");
authorizationUrl.searchParams.set("resource", resourceMcpUrl);

const authorizationPage = await fetch(networkUrl(authorizationUrl), { redirect: "manual" });
const authorizationHtml = await authorizationPage.text();
if (!authorizationPage.ok) {
  throw new Error(`Authorization page failed: ${authorizationPage.status}`);
}

if (mode === "preauth") {
  console.log(JSON.stringify({
    health: "ok",
    metadata: "ok",
    registration: "ok",
    authorizationPage: "ok",
    publicBaseUrl,
  }));
  process.exit(0);
}

const authFile = process.env.GAG_E2E_AUTH_FILE ?? (
  defaultConfigDir ? `${defaultConfigDir}/auth.json` : undefined
);
const ownerToken = process.env.GAG_E2E_OWNER_TOKEN ?? (
  authFile && existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")).ownerToken : undefined
);
if (!ownerToken || typeof ownerToken !== "string") {
  throw new Error("GAG_E2E_OWNER_TOKEN or GAG_E2E_AUTH_FILE is required.");
}

const authorizationForm = new URLSearchParams();
for (const match of authorizationHtml.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
  authorizationForm.set(decodeHtml(match[1]), decodeHtml(match[2]));
}
authorizationForm.set("owner_token", ownerToken);

const authorizationResponse = await fetch(networkUrl(authorizationUrl), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: authorizationForm,
  redirect: "manual",
});
if (authorizationResponse.status !== 302) {
  throw new Error(`Authorization failed: ${authorizationResponse.status}`);
}

const redirectLocation = authorizationResponse.headers.get("location");
const authorizationCode = redirectLocation
  ? new URL(redirectLocation).searchParams.get("code")
  : undefined;
if (!authorizationCode) {
  throw new Error("Authorization code was not returned.");
}

const token = await fetchJson(networkUrl(metadata.token_endpoint), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: resourceMcpUrl,
  }),
});

const client = new Client({ name: "gag-ec2-e2e", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(networkMcpUrl), {
  requestInit: {
    headers: { authorization: `Bearer ${token.access_token}` },
  },
});
await client.connect(transport);

const listedTools = await client.listTools();
const toolNames = new Set(listedTools.tools.map((tool) => tool.name));
for (const requiredTool of ["open_workspace", "read", "grep", "bash"]) {
  if (!toolNames.has(requiredTool)) {
    throw new Error(`Required MCP tool is missing: ${requiredTool}`);
  }
}

const opened = assertToolResult("open_workspace", await client.callTool({
  name: "open_workspace",
  arguments: { path: workspacePath },
}));
let workspaceId = opened.structuredContent?.workspaceId;
if (!workspaceId) {
  workspaceId = JSON.parse(resultText(opened)).workspaceId;
}
if (!workspaceId) {
  throw new Error("open_workspace did not return workspaceId.");
}

const readResult = assertToolResult("read", await client.callTool({
  name: "read",
  arguments: { workspaceId, path: "package.json", offset: 1, limit: 24 },
}));
if (!resultText(readResult).includes("@waishnav/devspace")) {
  throw new Error("read verification did not find the package name.");
}

const grepResult = assertToolResult("grep", await client.callTool({
  name: "grep",
  arguments: { workspaceId, path: "package.json", pattern: "ec2:doctor" },
}));
if (!resultText(grepResult).includes("ec2:doctor")) {
  throw new Error("grep verification did not find ec2:doctor.");
}

assertToolResult("test", await client.callTool({
  name: "bash",
  arguments: {
    workspaceId,
    command: "npx tsx src/config.test.ts",
    workingDirectory: ".",
    timeout: 120,
  },
}));

await client.close();
console.log(JSON.stringify({
  oauth: "ok",
  mcp: "ok",
  toolCount: listedTools.tools.length,
  workspaceId,
  read: "ok",
  grep: "ok",
  test: "ok",
}));
