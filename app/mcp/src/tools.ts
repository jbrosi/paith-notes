import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type ZodShape = Record<string, z.ZodTypeAny>;
type InferShape<T extends ZodShape> = { [K in keyof T]: z.infer<T[K]> };
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Wrapper around server.tool() that bypasses the MCP SDK's 6-overload resolution.
 * Without this, TypeScript recurses deeply into Zod types for every call, making
 * compilation take 60–80 seconds. Using `as any` once here keeps call sites
 * fully typed while keeping build times fast.
 */
function tool<T extends ZodShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: T,
  handler: (args: InferShape<T>) => Promise<ToolResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.tool as any)(name, description, schema, handler);
}

export interface ApiContext {
  token: string;
  scopes: Set<string>;
  apiBaseUrl: string;
}

function requireScope(scopes: Set<string>, scope: string): void {
  if (!scopes.has(scope)) {
    throw new Error(`insufficient_scope: ${scope}`);
  }
}

function requireNookRead(scopes: Set<string>, nookId: string): void {
  // nook:write implies read
  if (!scopes.has(`nook:read:${nookId}`) && !scopes.has(`nook:write:${nookId}`)) {
    throw new Error(`insufficient_scope: nook:read:${nookId}`);
  }
}

function requireNookWrite(scopes: Set<string>, nookId: string): void {
  requireScope(scopes, `nook:write:${nookId}`);
}

async function api(ctx: ApiContext, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${ctx.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer, ctx: ApiContext): void {
  tool(server,
    'list_nooks',
    'List all nooks (workspaces) the user is a member of',
    {},
    async () => json(await api(ctx, 'GET', '/api/nooks')),
  );

  tool(server,
    'list_notes',
    'List all notes in a nook',
    { nook_id: z.string().describe('The nook ID') },
    async ({ nook_id }) => {
      requireNookRead(ctx.scopes, nook_id);
      return json(await api(ctx, 'GET', `/api/nooks/${nook_id}/notes`));
    },
  );

  tool(server,
    'get_note',
    'Get a single note by ID',
    {
      nook_id: z.string(),
      note_id: z.string(),
    },
    async ({ nook_id, note_id }) => {
      requireNookRead(ctx.scopes, nook_id);
      return json(await api(ctx, 'GET', `/api/nooks/${nook_id}/notes/${note_id}`));
    },
  );

  tool(server,
    'create_note',
    'Create a new note in a nook',
    {
      nook_id: z.string(),
      title: z.string(),
      content: z.string().optional().describe(
        'Note content in markdown. ' +
        'To link to another note inline, use [[note:<note_id>]] — the title is resolved automatically. ' +
        'To embed a file note as an image, use ![Note Title](note:<note_id>).'
      ),
      type_id: z.string().optional().describe('Note type ID to assign'),
      properties: z.any().optional().describe('Arbitrary JSON properties'),
    },
    async ({ nook_id, ...body }) => {
      requireNookWrite(ctx.scopes, nook_id);
      return json(await api(ctx, 'POST', `/api/nooks/${nook_id}/notes`, body));
    },
  );

  tool(server,
    'update_note',
    'Update an existing note (only title, content, or properties)',
    {
      nook_id: z.string(),
      note_id: z.string(),
      title: z.string().optional(),
      content: z.string().optional().describe(
        'Note content in markdown. ' +
        'To link to another note inline, use [[note:<note_id>]] — the title is resolved automatically. ' +
        'To embed a file note as an image, use ![Note Title](note:<note_id>).'
      ),
      properties: z.any().optional(),
    },
    async ({ nook_id, note_id, ...body }) => {
      requireNookWrite(ctx.scopes, nook_id);
      return json(await api(ctx, 'PATCH', `/api/nooks/${nook_id}/notes/${note_id}`, body));
    },
  );

  tool(server,
    'delete_note',
    'Delete a note (only the note creator or nook owner can delete)',
    {
      nook_id: z.string(),
      note_id: z.string(),
    },
    async ({ nook_id, note_id }) => {
      requireNookWrite(ctx.scopes, nook_id);
      await api(ctx, 'DELETE', `/api/nooks/${nook_id}/notes/${note_id}`);
      return json({ success: true });
    },
  );

  tool(server,
    'list_note_types',
    'List note types (taxonomy) defined in a nook',
    { nook_id: z.string() },
    async ({ nook_id }) => {
      requireNookRead(ctx.scopes, nook_id);
      return json(await api(ctx, 'GET', `/api/nooks/${nook_id}/types`));
    },
  );

  tool(server,
    'search_notes_by_type',
    'List or search notes filtered by a specific note type, with optional text search and pagination',
    {
      nook_id: z.string(),
      type_id: z.string(),
      search: z.string().optional().describe('Text search query'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
    async ({ nook_id, type_id, search, cursor }) => {
      requireNookRead(ctx.scopes, nook_id);
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString() ? `?${params}` : '';
      return json(await api(ctx, 'GET', `/api/nooks/${nook_id}/types/${type_id}/notes${qs}`));
    },
  );

  tool(server,
    'get_note_links',
    'Get links for a note, with optional graph traversal depth',
    {
      nook_id: z.string(),
      note_id: z.string(),
      direction: z.enum(['out', 'in', 'both']).optional(),
      depth: z.number().int().min(1).max(5).optional(),
    },
    async ({ nook_id, note_id, direction, depth }) => {
      requireNookRead(ctx.scopes, nook_id);
      const params = new URLSearchParams({ direction: direction ?? 'both', depth: String(depth ?? 1) });
      return json(await api(ctx, 'GET', `/api/nooks/${nook_id}/notes/${note_id}/links?${params}`));
    },
  );

  tool(server,
    'create_note_link',
    'Create a directed link between two notes using a predicate',
    {
      nook_id: z.string(),
      source_note_id: z.string(),
      target_note_id: z.string(),
      predicate_id: z.string().describe('The link predicate ID (use list_note_types or predicates endpoint)'),
      start_date: z.string().optional().describe('ISO date string'),
      end_date: z.string().optional().describe('ISO date string'),
    },
    async ({ nook_id, source_note_id, ...body }) => {
      requireNookWrite(ctx.scopes, nook_id);
      return json(await api(ctx, 'POST', `/api/nooks/${nook_id}/notes/${source_note_id}/links`, body));
    },
  );
}
