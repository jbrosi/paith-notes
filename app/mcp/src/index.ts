import dns from "node:dns";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { extractToken, getIssuer, initAuth, unauthorized } from "./auth.js";
import { createChatRouter, parseContextLimit } from "./chat.js";
import { registerTools } from "./tools.js";

// Force IPv4-first DNS resolution. node:22's native fetch (undici)
// prefers IPv6 and hangs when the Docker bridge network has no working
// IPv6 path — outbound calls to e.g. Open-Meteo or Wikipedia fail with
// the unhelpful "fetch failed" while wget/curl from the same container
// work because they default to IPv4. This brings fetch back in line.
dns.setDefaultResultOrder("ipv4first");

const {
	KEYCLOAK_BASE_URL,
	KEYCLOAK_REALM,
	API_BASE_URL,
	MCP_SERVER_URL,
	ANTHROPIC_API_KEY,
	ANTHROPIC_BASE_URL,
	CHAT_CONTEXT_LIMIT,
	PORT = "3000",
} = process.env;

if (!KEYCLOAK_BASE_URL || !KEYCLOAK_REALM || !API_BASE_URL || !MCP_SERVER_URL) {
	console.error(
		"Missing required env vars: KEYCLOAK_BASE_URL, KEYCLOAK_REALM, API_BASE_URL, MCP_SERVER_URL",
	);
	process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
	console.warn(
		"Warning: ANTHROPIC_API_KEY not set — /chat endpoints will not work",
	);
}
// The Anthropic SDK reads ANTHROPIC_BASE_URL itself; log it so a proxy
// override (e.g. LiteLLM) is obvious in the container logs, and flag a
// value without an http(s):// scheme — the SDK can't build request URLs
// from it, so every chat request would fail.
const anthropicBaseUrl = ANTHROPIC_BASE_URL?.trim();
if (anthropicBaseUrl) {
	if (
		/^https?:\/\//i.test(anthropicBaseUrl) &&
		URL.canParse(anthropicBaseUrl)
	) {
		console.log(`Anthropic API base URL overridden: ${anthropicBaseUrl}`);
	} else {
		console.warn(
			`Warning: ANTHROPIC_BASE_URL "${anthropicBaseUrl}" is not an http(s):// URL — /chat endpoints will not work`,
		);
	}
}
if (CHAT_CONTEXT_LIMIT?.trim()) {
	const limit = parseContextLimit(CHAT_CONTEXT_LIMIT);
	if (limit) {
		console.log(`Chat context limit overridden: ${limit} tokens`);
	} else {
		console.warn(
			`Warning: CHAT_CONTEXT_LIMIT "${CHAT_CONTEXT_LIMIT.trim()}" is not a positive integer — using per-model limits`,
		);
	}
}

initAuth(KEYCLOAK_BASE_URL, KEYCLOAK_REALM);

const app = express();
app.set("trust proxy", 1); // behind Caddy reverse proxy
// 30 MB — chat POSTs can carry base64 image attachments (up to 4 originals +
// previews). The PHP /chat-images endpoint has its own ~40 MB decoded cap;
// this just keeps the JSON body under that. express.json() defaults to 100kb,
// which is far too small for any real image.
app.use(express.json({ limit: "30mb" }));

// OAuth Protected Resource Metadata
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
	res.json({
		resource: MCP_SERVER_URL,
		authorization_servers: [getIssuer()],
	});
});

// MCP endpoint (stateless — new server instance per request)
app.all("/mcp", async (req, res) => {
	const auth = await extractToken(req.headers.authorization);
	if (!auth) {
		unauthorized(res, MCP_SERVER_URL);
		return;
	}

	const server = new McpServer({ name: "paith-notes", version: "1.0.0" });
	registerTools(server, {
		token: auth.token,
		scopes: auth.scopes,
		apiBaseUrl: API_BASE_URL,
	});

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});

	res.on("finish", () => {
		transport.close();
		server.close();
	});

	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

// Chat endpoints
app.use("/", createChatRouter(API_BASE_URL));

app.listen(parseInt(PORT, 10), () => {
	console.log(`paith-notes service listening on :${PORT}`);
});
