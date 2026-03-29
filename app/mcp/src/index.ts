import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initAuth, extractToken, unauthorized, getIssuer } from './auth.js';
import { registerTools } from './tools.js';
import { createChatRouter } from './chat.js';

const {
  KEYCLOAK_BASE_URL,
  KEYCLOAK_REALM,
  API_BASE_URL,
  MCP_SERVER_URL,
  ANTHROPIC_API_KEY,
  PORT = '3000',
} = process.env;

if (!KEYCLOAK_BASE_URL || !KEYCLOAK_REALM || !API_BASE_URL || !MCP_SERVER_URL) {
  console.error('Missing required env vars: KEYCLOAK_BASE_URL, KEYCLOAK_REALM, API_BASE_URL, MCP_SERVER_URL');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.warn('Warning: ANTHROPIC_API_KEY not set — /chat endpoints will not work');
}

initAuth(KEYCLOAK_BASE_URL, KEYCLOAK_REALM);

const app = express();
app.set('trust proxy', 1); // behind Caddy reverse proxy
app.use(express.json());

// OAuth Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: MCP_SERVER_URL,
    authorization_servers: [getIssuer()],
  });
});

// MCP endpoint (stateless — new server instance per request)
app.all('/mcp', async (req, res) => {
  const auth = await extractToken(req.headers.authorization);
  if (!auth) {
    unauthorized(res, MCP_SERVER_URL);
    return;
  }

  const server = new McpServer({ name: 'paith-notes', version: '1.0.0' });
  registerTools(server, { token: auth.token, scopes: auth.scopes, apiBaseUrl: API_BASE_URL });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('finish', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Chat endpoints
app.use('/', createChatRouter(API_BASE_URL));

app.listen(parseInt(PORT), () => {
  console.log(`paith-notes service listening on :${PORT}`);
});
