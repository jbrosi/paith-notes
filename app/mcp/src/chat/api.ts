import type Anthropic from '@anthropic-ai/sdk';

/**
 * Thin wrappers around the PHP API. These are the only places outside
 * of chat.ts that hit /api/* on the app-side backend; everything else
 * in the streaming loop goes through Anthropic.
 *
 * Design constraints:
 *   - Always send `X-Nook-Actor: ai` so the middleware knows this is
 *     the AI actor (drives nook-AI-policy enforcement).
 *   - Best-effort helpers (recordNoteConvLink, resolveMemoryNookId,
 *     ...) swallow errors — they're fire-and-forget metadata; failing
 *     one shouldn't abort the user's chat turn.
 */

export type PhpMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: Anthropic.MessageParam['content'];
  model?: string | null;
};

export type SavedBlock = { id: string; blockType: string; toolUseId?: string };
export type SavedTurn = { turnId: string; role: string; blocks: SavedBlock[] };

export type InstructionNote = { id: string; title: string };

export async function verifySession(cookieHeader: string, apiBase: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/chat/auth`, {
    headers: { Cookie: cookieHeader },
  });
  return res.ok;
}

export async function phpApi(
  method: string,
  path: string,
  cookie: string,
  apiBase: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Nook-Actor': 'ai',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PHP API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function loadHistory(
  conversationId: string,
  cookie: string,
  apiBase: string,
): Promise<Anthropic.MessageParam[]> {
  const data = await phpApi('GET', `/api/conversations/${conversationId}/messages`, cookie, apiBase) as { messages: PhpMessage[] };
  return data.messages.map(m => ({ role: m.role, content: m.content }));
}

export async function saveMessages(
  conversationId: string,
  messages: Array<{ role: string; content: unknown; model?: string | null }>,
  cookie: string,
  apiBase: string,
): Promise<SavedTurn[]> {
  const data = await phpApi(
    'POST',
    `/api/conversations/${conversationId}/messages`,
    cookie,
    apiBase,
    { messages },
  ) as { turns?: Array<{ turn_id: string; role: string; blocks: Array<{ id: string; block_type: string; tool_use_id?: string }> }> };

  return (data.turns ?? []).map(t => ({
    turnId: t.turn_id,
    role: t.role,
    blocks: (t.blocks ?? []).map(b => ({
      id: b.id,
      blockType: b.block_type,
      toolUseId: b.tool_use_id,
    })),
  }));
}

export async function recordNoteConvLink(
  noteId: string,
  conversationId: string,
  blockId: string | undefined,
  apiBase: string,
  cookie: string,
): Promise<void> {
  try {
    await phpApi('POST', `/api/conversations/${conversationId}/note-links`, cookie, apiBase, {
      note_id: noteId,
      block_id: blockId ?? null,
    });
  } catch { /* best-effort */ }
}

export async function resolveNookName(nookId: string, cookie: string, apiBase: string): Promise<string> {
  try {
    const data = await phpApi('GET', '/api/nooks', cookie, apiBase) as { nooks?: Array<{ id: string; name: string }> } | null;
    return data?.nooks?.find(n => n.id === nookId)?.name ?? '';
  } catch {
    return '';
  }
}

export async function resolveMemoryNookId(cookie: string, apiBase: string): Promise<string | null> {
  try {
    const data = await phpApi('GET', '/api/nooks/ai-memory', cookie, apiBase) as { nook?: { id?: string } };
    return data?.nook?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveHandbookNookId(cookie: string, apiBase: string): Promise<string | null> {
  try {
    const data = await phpApi('GET', '/api/nooks/handbook', cookie, apiBase) as { nook?: { id?: string } };
    return data?.nook?.id ?? null;
  } catch {
    return null;
  }
}

export async function fetchHandbookNotes(handbookNookId: string, cookie: string, apiBase: string): Promise<InstructionNote[]> {
  try {
    const data = await phpApi(
      'GET',
      `/api/nooks/${encodeURIComponent(handbookNookId)}/note-types/all/notes?limit=50&sort=updated_newest`,
      cookie,
      apiBase,
    ) as { notes?: Array<{ id: string; title: string }> };
    return (data?.notes ?? []).map(n => ({ id: n.id, title: n.title }));
  } catch {
    return [];
  }
}

export async function fetchInstructionNotes(
  nookId: string,
  cookie: string,
  apiBase: string,
): Promise<InstructionNote[]> {
  try {
    // First resolve the 'ai-instruction' type key to its UUID
    const typesData = await phpApi(
      'GET',
      `/api/nooks/${encodeURIComponent(nookId)}/note-types`,
      cookie,
      apiBase,
    ) as { types?: Array<{ id: string; key: string }> };
    const instructionType = typesData?.types?.find(t => t.key === 'ai-instruction');
    if (!instructionType) return [];

    // Fetch notes of that type
    const data = await phpApi(
      'GET',
      `/api/nooks/${encodeURIComponent(nookId)}/note-types/${instructionType.id}/notes?limit=50`,
      cookie,
      apiBase,
    ) as { notes?: Array<{ id: string; title: string }> };
    return (data?.notes ?? []).map(n => ({ id: n.id, title: n.title }));
  } catch {
    return [];
  }
}

export async function fetchMemoryInstructionNotes(
  memoryNookId: string,
  cookie: string,
  apiBase: string,
): Promise<InstructionNote[]> {
  try {
    // In the memory nook, all notes serve as context — just get recent ones as summaries
    const data = await phpApi(
      'GET',
      `/api/nooks/${encodeURIComponent(memoryNookId)}/note-types/all/notes?limit=20&sort=updated_newest`,
      cookie,
      apiBase,
    ) as { notes?: Array<{ id: string; title: string }> };
    return (data?.notes ?? []).map(n => ({ id: n.id, title: n.title }));
  } catch {
    return [];
  }
}
