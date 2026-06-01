import { Router } from 'express';
import type express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { TOOLS, executeTool } from './chat-tools.js';
import { runSearchAgent, type SearchAgentContext } from './search-agent.js';

function buildConversationSummary(messages: Anthropic.MessageParam[], maxLength = 500): string {
  const parts: string[] = [];
  let len = 0;
  for (const msg of messages) {
    if (len >= maxLength) break;
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
    for (const block of blocks) {
      if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
        const text = String(block.text).slice(0, 150);
        parts.push(`${msg.role}: ${text}`);
        len += text.length;
        if (len >= maxLength) break;
      }
    }
  }
  return parts.join('\n');
}

async function resolveNookName(nookId: string, cookie: string, apiBase: string): Promise<string> {
  try {
    const data = await phpApi('GET', '/api/nooks', cookie, apiBase) as { nooks?: Array<{ id: string; name: string }> } | null;
    return data?.nooks?.find(n => n.id === nookId)?.name ?? '';
  } catch {
    return '';
  }
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS    = 8096;
const MAX_AUTO_DEPTH = 8;

// Context window limits per model (input tokens)
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
};
const DEFAULT_CONTEXT_LIMIT = 200000;
const CONTEXT_SOFT_THRESHOLD = 0.5;     // 50% — gentle nudge on topic shifts
const CONTEXT_WARNING_THRESHOLD = 0.7;  // 70% — show indicator, suggest new chat
const CONTEXT_CRITICAL_THRESHOLD = 0.9; // 90% — strongly encourage new chat

// Tools that are always safe to auto-execute (read-only / non-destructive)
const ALWAYS_AUTO_TOOLS = new Set([
  'list_note_types',
  'list_type_attributes',
  'list_link_predicates',
  'search_notes',
  'explore_notes',
  'get_note_mentions',
  'memory_search',
  'memory_get',
  'memory_create',
  'memory_update',
]);

function sse(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseHeaders(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ─── Forward-auth ─────────────────────────────────────────────────────────────

async function verifySession(cookieHeader: string, apiBase: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/chat/auth`, {
    headers: { Cookie: cookieHeader },
  });
  return res.ok;
}

// ─── PHP API helpers ─────────────────────────────────────────────────────────

async function phpApi(
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

type PhpMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: Anthropic.MessageParam['content'];
  model?: string | null;
};

async function loadHistory(
  conversationId: string,
  cookie: string,
  apiBase: string,
): Promise<Anthropic.MessageParam[]> {
  const data = await phpApi('GET', `/api/conversations/${conversationId}/messages`, cookie, apiBase) as { messages: PhpMessage[] };
  return data.messages.map(m => ({ role: m.role, content: m.content }));
}

type SavedBlock = { id: string; blockType: string; toolUseId?: string };
type SavedTurn  = { turnId: string; role: string; blocks: SavedBlock[] };

async function saveMessages(
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

async function recordNoteConvLink(
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

// ─── Display name resolution ─────────────────────────────────────────────────

// Accepts only UUID v4 format, which is the ID format used throughout this app.
const NOOK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateNookId(nookId: string): string {
  if (!NOOK_ID_RE.test(nookId)) throw new Error(`Invalid nookId: ${nookId}`);
  return nookId;
}

type ResolvedName = { label: string; url?: string };

async function resolveDisplayNames(
  tools: Array<{ name: string; input: Record<string, unknown> }>,
  nookId: string,
  apiBase: string,
  cookie: string,
  memoryNookId?: string | null,
): Promise<Record<string, ResolvedName>> {
  const safeNookId = encodeURIComponent(validateNookId(nookId));
  const names: Record<string, ResolvedName> = {};
  const predicateIds = new Set<string>();

  // Collect (noteId, resolvedNookId) pairs — each note knows its nook
  const noteEntries: Array<{ noteId: string; noteNookId: string }> = [];
  for (const tool of tools) {
    // Determine which nook this tool operates on
    let toolNookId = safeNookId;
    if (tool.name.startsWith('memory_') && memoryNookId) {
      toolNookId = encodeURIComponent(memoryNookId);
    } else if (typeof tool.input.nook_id === 'string' && tool.input.nook_id.trim() !== '') {
      toolNookId = encodeURIComponent(tool.input.nook_id.trim());
    }

    for (const key of ['note_id', 'source_note_id', 'target_note_id']) {
      if (typeof tool.input[key] === 'string') {
        noteEntries.push({ noteId: tool.input[key] as string, noteNookId: toolNookId });
      }
    }
    if (typeof tool.input.predicate_id === 'string') predicateIds.add(tool.input.predicate_id as string);
  }

  await Promise.all([
    ...noteEntries.map(async ({ noteId, noteNookId }) => {
      if (names[noteId]) return; // already resolved
      try {
        const res = await fetch(`${apiBase}/api/nooks/${noteNookId}/notes/${encodeURIComponent(noteId)}`, {
          headers: { Cookie: cookie },
        });
        if (res.ok) {
          const data = await res.json() as { note?: { title?: string } };
          names[noteId] = { label: data.note?.title ?? noteId, url: `/nooks/${noteNookId}/notes/${encodeURIComponent(noteId)}` };
        }
      } catch { /* best-effort */ }
    }),
    predicateIds.size > 0
      ? (async () => {
          try {
            const res = await fetch(`${apiBase}/api/nooks/${safeNookId}/link-predicates`, {
              headers: { Cookie: cookie },
            });
            if (res.ok) {
              const data = await res.json() as { predicates?: Array<{ id: string; forward_label: string }> };
              for (const p of data.predicates ?? []) {
                if (predicateIds.has(p.id)) names[p.id] = { label: p.forward_label };
              }
            }
          } catch { /* best-effort */ }
        })()
      : Promise.resolve(),
  ]);

  return names;
}

// ─── Auto-execution helpers ───────────────────────────────────────────────────

function isAutoExecutable(toolName: string, input?: Record<string, unknown>, instructionNoteIds?: Set<string>): boolean {
  if (ALWAYS_AUTO_TOOLS.has(toolName)) return true;
  // get_note is auto-approved for AI instruction notes and search_all_nooks
  if (toolName === 'get_note' && instructionNoteIds && typeof input?.note_id === 'string') {
    if (instructionNoteIds.has(input.note_id)) return true;
  }
  if (toolName === 'search_all_nooks') return true;
  return false;
}

// ─── AI memory nook ──────────────────────────────────────────────────────────

async function resolveMemoryNookId(cookie: string, apiBase: string): Promise<string | null> {
  try {
    const data = await phpApi('GET', '/api/nooks/ai-memory', cookie, apiBase) as { nook?: { id?: string } };
    return data?.nook?.id ?? null;
  } catch {
    return null;
  }
}

// ─── AI Instructions ─────────────────────────────────────────────────────────

type InstructionNote = { id: string; title: string };

async function fetchInstructionNotes(
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

async function fetchMemoryInstructionNotes(
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

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  nookId: string,
  nookName: string,
  nookRole: string,
  contextNote?: { id: string; title: string; type?: string },
  memoryNookId?: string | null,
  nookInstructions?: InstructionNote[],
  memoryNotes?: InstructionNote[],
): string {
  const nookDisplay = nookName ? `"${nookName}" (${nookId})` : `"${nookId}"`;
  const roleInfo = nookRole ? ` The user's role in this nook is "${nookRole}".` : '';
  const parts = [
    `You are an assistant integrated into paith notes. You are operating in nook ${nookDisplay}.${roleInfo} Current date: ${new Date().toISOString().slice(0, 10)}.

CRITICAL — Note link format:
Every time you mention a note by name in your response text, you MUST use the [[note:...]] syntax. The UI automatically replaces this with a clickable link showing the note's title — the user never sees the UUID. NEVER write bare UUIDs, shortened IDs, or note titles as plain text when you know the note's ID. NEVER truncate UUIDs. Always use the complete UUID.

For notes in the CURRENT nook: [[note:<noteId>]]
For notes in a DIFFERENT nook (cross-nook): [[note:<nookId>/<noteId>]]

You MUST ALWAYS use the cross-nook format [[note:nookId/noteId]] in your chat responses and when writing AI memory notes — because conversations and memories are stored separately from the user's nooks. Without the nook ID prefix, links will not resolve.

Examples:
- Same nook: "I found context in [[note:a1b2c3d4-e5f6-7890-abcd-ef1234567890]]."
- Cross-nook: "Related to [[note:b55dbf0d-a2bc-46a2-b296-ef71cd2306a3/a1b2c3d4-e5f6-7890-abcd-ef1234567890]]."
- WRONG: "I found relevant context in b12d16a3..."
- WRONG: "I found relevant context in the note 'Meeting Notes'."
To embed a file note as an image: ![alt text](note:<full_uuid>) or ![alt text](note:<nookId>/<noteId>)

General rules:
- You have access to the user's notes via tools — never ask for a nook ID or note ID, use the IDs from tool results directly.
- Only use tools when the user explicitly asks. Always tell the user what you are about to do before calling a tool.
- When you need to make multiple independent tool calls, issue them all in a single response as parallel tool_use blocks rather than sequentially.

**search_notes behavior:** The q parameter is optional — omit it or pass an empty string to list all notes (optionally filtered by type_id). Do NOT search for common words like "a" or "the" to find all notes. Multiple words are automatically split: by default all must match (AND). Use search_mode="or" if you want any word to match. The same applies to explore_notes q parameter.

**search_agent:** When you need to research a topic across multiple notes, use the search_agent tool instead of searching manually. The search agent runs in its own context window, can search and read notes across all accessible nooks, and returns ranked results with relevant excerpts — keeping this conversation's context clean. The user must approve before it runs. Always tell the user what you're about to search for before calling it. Use it for:
- Broad research questions ("find everything about X")
- Questions that may require reading multiple notes to synthesize an answer
- When context usage is high and you need to search
For simple, targeted lookups (one search + one note read), use search_notes/get_note directly — the search agent adds overhead for trivial queries.

**Tool approval:** The following tools auto-execute without user approval: search_notes, explore_notes, get_note_mentions, list_note_types, list_type_attributes, list_link_predicates, and all memory_* tools (memory_search, memory_get, memory_create, memory_update). All other tools (get_note, create_note, update_note, delete_note, create_note_link, open_note, create_note_type, update_note_type, search_agent) require user confirmation.

**Mermaid diagrams:** Both note content and your chat responses support mermaid diagrams via fenced code blocks (\`\`\`mermaid). Use them when visualizing relationships, flows, timelines, or architectures would help the user. The UI renders them as interactive SVGs.`,
    memoryNookId
      ? `**AI Memory:** You have a personal memory nook for this user (ID: ${memoryNookId}). Use the memory_* tools (memory_search, memory_get, memory_create, memory_update) to store and retrieve knowledge about the user — preferences, facts, communication style, corrections, project context. These are auto-approved and persist across all nooks and conversations.

At the start of each conversation, proactively search user memory with memory_search() to recall relevant context. When the user shares preferences or corrects you, store it in user memory immediately.

**Memory retrieval protocol:** Before answering any question about past context or preferences: (1) call memory_search(q="<topic>") to find relevant memories, (2) call memory_get on matches to read full content. Only after checking memory should you search the current nook's notes.

When you create or update a memory note, the system automatically links it to the current conversation — this builds a knowledge trail showing why each memory exists and which conversations contributed to it.`
      : '',
    `**Note type taxonomy:** You can help the user manage their note taxonomy. Use list_note_types to see the full hierarchy before suggesting or creating types. When creating a type, always tell the user where in the hierarchy it will appear (e.g. "Creating 'Employee' as a subtype of 'Person'"). You can update a type's label or description with update_note_type. Never create a type without showing the user what you're about to create and where it fits.`,
    `**Type attributes:** Each type can have structured attributes (text, number, boolean, date, date_range, select, file, graph). Use list_type_attributes to see what a type supports — this returns attribute IDs, names, kinds, and config. When creating or updating notes, pass attribute values in the "attributes" field as { "<attribute_uuid>": value }. Attributes are inherited from parent types. Example workflow:
1. list_note_types to find the type
2. list_type_attributes to see its attributes and their UUIDs
3. create_note with type_id and attributes: { "<rating_attr_id>": 5, "<author_attr_id>": "Le Guin" }

Attribute kinds and value formats:
- text: string value
- number: numeric value
- boolean: true/false
- date: "YYYY-MM-DD" string
- date_range: { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
- select: string matching one of the configured options
- file: managed by the file upload system (don't set directly)
- graph: { rootNoteId: "<uuid>", depth?: 2, layout?: "force"|"tree"|"radial", ... }`,
    `**Conversation hygiene:** When you notice the user switching to a completely different topic, gently suggest starting a new chat — this keeps conversations focused and searchable. Before they do, offer to:
- Save nook-specific outcomes/decisions as a note in the current nook (using create_note)
- Save personal preferences or cross-nook context to memory (using memory_create/memory_update)
The more context has been used, the more you should encourage this. After saving, tell the user to click "New chat" to continue fresh.`,
  ];

  if (nookInstructions && nookInstructions.length > 0) {
    const list = nookInstructions.map(n => `- "${n.title}" (ID: ${n.id})`).join('\n');
    parts.push(
      `**Nook-specific AI instructions:** The following instruction notes exist in this nook. Reading these via get_note is FREE (auto-approved, no user confirmation needed). Read any that are relevant to the user's current request:\n${list}\n\nThese contain nook-specific guidelines — formatting rules, domain knowledge, conventions, etc.`,
    );
  }

  if (memoryNotes && memoryNotes.length > 0) {
    const list = memoryNotes.map(n => `- "${n.title}" (ID: ${n.id})`).join('\n');
    parts.push(
      `**Personal memory notes:** The following memory notes exist about your relationship with this user. Reading these via get_note is FREE (auto-approved):\n${list}\n\nThese contain personal preferences, past context, corrections. You do NOT need to read all of them — pick based on relevance to the current conversation.`,
    );
  }

  if (contextNote) {
    parts.push(
      `\nThe user currently has a note open in their editor. When they say "this note", "the current note", "my note", "here", or anything similar, they are referring to this note — use its ID directly without asking which note they mean:\nTitle: ${contextNote.title}\nID: ${contextNote.id}\nType: ${contextNote.type ?? 'note'}\n\nTo read the full content of this note, use the get_note tool (the user will be asked to confirm).\n\n**When asked about context related to this note:** (1) call explore_notes(note_id="${contextNote.id}", direction="both") — free, surfaces all linked notes, (2) call get_note_mentions to find [[note:id]] text references (free), (3) check user memory with memory_search for relevant context. Issue independent calls in parallel.`,
    );
  }

  return parts.join('\n\n');
}

// ─── Core streaming function ─────────────────────────────────────────────────

async function streamConversation(
  res: express.Response,
  messages: Anthropic.MessageParam[],
  model: string,
  conversationId: string,
  cookie: string,
  apiBase: string,
  nookId: string,
  contextNote?: { id: string; title: string; type?: string },
  memoryNookId?: string | null,
): Promise<void> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Resolve nook name, role, and instruction notes in parallel
  let nookName = '';
  let nookRole = '';
  let nookInstructions: InstructionNote[] = [];
  let memoryNotes: InstructionNote[] = [];

  const [nooksData] = await Promise.all([
    phpApi('GET', '/api/nooks', cookie, apiBase).catch(() => null) as Promise<{ nooks?: Array<{ id: string; name: string; role: string }> } | null>,
    fetchInstructionNotes(nookId, cookie, apiBase).then(r => { nookInstructions = r; }),
    memoryNookId ? fetchMemoryInstructionNotes(memoryNookId, cookie, apiBase).then(r => { memoryNotes = r; }) : Promise.resolve(),
  ]);

  if (nooksData?.nooks) {
    const found = nooksData.nooks.find(n => n.id === nookId);
    nookName = found?.name ?? '';
    nookRole = found?.role ?? '';
  }

  const baseSystemPrompt = buildSystemPrompt(nookId, nookName, nookRole, contextNote, memoryNookId, nookInstructions, memoryNotes);
  let systemPrompt = baseSystemPrompt;
  const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;

  // IDs of instruction notes that can be auto-read without user approval
  const instructionNoteIds = new Set([
    ...nookInstructions.map(n => n.id),
    ...memoryNotes.map(n => n.id),
  ]);

  // mutable copy we extend on each auto-execute loop
  const msgs: Anthropic.MessageParam[] = [...messages];
  let lastInputTokens = 0;

  try {
    for (let depth = 0; depth <= MAX_AUTO_DEPTH; depth++) {
      // Add context pressure hint based on actual token count from previous iteration
      if (lastInputTokens > 0) {
        const ratio = lastInputTokens / contextLimit;
        if (ratio > CONTEXT_CRITICAL_THRESHOLD) {
          systemPrompt = baseSystemPrompt + '\n\n**CRITICAL — Context window is ' + Math.round(ratio * 100) + '% full.** You MUST:\n1. Keep responses very concise\n2. Strongly encourage the user to start a new chat\n3. Offer to summarize key outcomes/decisions into a memory note before they do\n4. After saving to memory, tell the user to click "New chat" to continue fresh';
        } else if (ratio > CONTEXT_WARNING_THRESHOLD) {
          systemPrompt = baseSystemPrompt + '\n\n**Context window is ' + Math.round(ratio * 100) + '% full.** Suggest starting a new chat soon. Offer to summarize outcomes to memory first. Keep responses concise.';
        } else if (ratio > CONTEXT_SOFT_THRESHOLD) {
          systemPrompt = baseSystemPrompt + '\n\n**Context note:** Window is ' + Math.round(ratio * 100) + '% full. If the user switches topics or you sense a natural break, gently suggest starting a new chat. No need to force it.';
        }
      }
      type StoredBlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;
      const contentBlocks: StoredBlock[] = [];
      let currentText = '';
      let currentTool: { id: string; name: string; partialInput: string } | null = null;
      const pendingToolUses: Anthropic.ToolUseBlockParam[] = [];

      const stream = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        tools: TOOLS,
        messages: msgs,
        system: systemPrompt,
        stream: true,
      });

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        if (event.type === 'message_start') {
          inputTokens = (event as unknown as { message?: { usage?: { input_tokens?: number } } }).message?.usage?.input_tokens ?? 0;
          lastInputTokens = inputTokens;
        }
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            currentText = '';
          } else if (event.content_block.type === 'tool_use') {
            currentTool = { id: event.content_block.id, name: event.content_block.name, partialInput: '' };
          }
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text;
            sse(res, 'text_delta', { delta: event.delta.text });
          } else if (event.delta.type === 'input_json_delta' && currentTool) {
            currentTool.partialInput += event.delta.partial_json;
          }
        }

        if (event.type === 'content_block_stop') {
          if (currentText !== '') {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          if (currentTool) {
            const toolInput = JSON.parse(currentTool.partialInput || '{}') as Record<string, unknown>;
            const toolBlock: Anthropic.ToolUseBlockParam = {
              type: 'tool_use',
              id: currentTool.id,
              name: currentTool.name,
              input: toolInput,
            };
            contentBlocks.push(toolBlock);
            pendingToolUses.push(toolBlock);
            sse(res, 'tool_use', { id: toolBlock.id, name: toolBlock.name, input: toolBlock.input });
            currentTool = null;
          }
        }

        if (event.type === 'message_delta') {
          outputTokens += (event as unknown as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0;
          const stopReason = event.delta.stop_reason;

          const savedAssistantTurns = await saveMessages(
            conversationId,
            [{ role: 'assistant', content: contentBlocks, model }],
            cookie,
            apiBase,
          );

          if (stopReason === 'end_turn') {
            const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
            const totalTokens = inputTokens + outputTokens;
            sse(res, 'done', {
              conversation_id: conversationId,
              usage: { input_tokens: inputTokens, output_tokens: outputTokens, context_limit: contextLimit },
            });

            // If context is critically full, append a system hint for next turn
            if (totalTokens > contextLimit * CONTEXT_CRITICAL_THRESHOLD) {
              sse(res, 'context_warning', { level: 'critical', usage_ratio: totalTokens / contextLimit });
            } else if (totalTokens > contextLimit * CONTEXT_WARNING_THRESHOLD) {
              sse(res, 'context_warning', { level: 'warning', usage_ratio: totalTokens / contextLimit });
            }
            return;
          }

          if (stopReason === 'tool_use') {
            // Check if all tools can be auto-executed
            const toolsPayload = pendingToolUses.map(t => ({
              id: t.id,
              name: t.name,
              input: t.input as Record<string, unknown>,
            }));

            if (toolsPayload.every(t => isAutoExecutable(t.name, t.input, instructionNoteIds))) {
              // Auto-execute all tools, loop for next AI turn
              const assistantBlocks = savedAssistantTurns[0]?.blocks ?? [];

              const resultBlocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
                toolsPayload.map(async (t, i): Promise<Anthropic.ToolResultBlockParam> => {
                  let resultContent: string;
                  let isError = false;
                  try {
                    if (t.name === 'search_agent') {
                      const agentCtx: SearchAgentContext = {
                        contextNote: contextNote ?? undefined,
                        nookInstructions,
                        memoryNotes,
                        conversationSummary: buildConversationSummary(msgs),
                      };
                      resultContent = await runSearchAgent(
                        String(t.input.task ?? ''),
                        model,
                        apiBase,
                        cookie,
                        nookId,
                        nookName,
                        memoryNookId ?? undefined,
                        (status) => sse(res, 'search_agent_progress', { tool_use_id: t.id, status }),
                        agentCtx,
                      );
                    } else {
                      resultContent = await executeTool(t.name, t.input, apiBase, cookie, nookId, memoryNookId ?? undefined);
                    }
                  } catch (err) {
                    resultContent = `Error: ${err instanceof Error ? err.message : 'unknown'}`;
                    isError = true;
                  }

                  // Record note-conversation link for auto-executed writes (including memory tools)
                  if (!isError && (t.name === 'create_note' || t.name === 'update_note' || t.name === 'memory_create' || t.name === 'memory_update')) {
                    try {
                      const resultData = JSON.parse(resultContent) as { note?: { id?: string } };
                      const noteId = resultData.note?.id;
                      if (noteId) {
                        const savedBlock = assistantBlocks.find(b => b.toolUseId === t.id);
                        await recordNoteConvLink(noteId, conversationId, savedBlock?.id, apiBase, cookie);
                      }
                    } catch { /* best-effort */ }
                  }

                  return isError
                    ? { type: 'tool_result', tool_use_id: t.id, content: resultContent, is_error: true }
                    : { type: 'tool_result', tool_use_id: t.id, content: resultContent };
                }),
              );

              await saveMessages(
                conversationId,
                [{ role: 'user', content: resultBlocks }],
                cookie,
                apiBase,
              );

              msgs.push({ role: 'assistant', content: contentBlocks });
              msgs.push({ role: 'user', content: resultBlocks });
              // break out of `for await` to loop again
              break;
            } else {
              // Needs user approval
              const displayNames = await resolveDisplayNames(toolsPayload, nookId, apiBase, cookie, memoryNookId);
              sse(res, 'awaiting_approval', {
                conversation_id: conversationId,
                tools: toolsPayload,
                display_names: displayNames,
                nook_name: nookName,
                nook_id: nookId,
              });
              return;
            }
          }
        }
      }
    }

    // Fell through MAX_AUTO_DEPTH — shouldn't normally happen
    sse(res, 'error', { message: 'Auto-execution depth limit reached' });
  } catch (err) {
    sse(res, 'error', { message: err instanceof Error ? err.message : 'unknown error' });
  } finally {
    res.end();
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function createChatRouter(apiBase: string): Router {
  const router = Router();

  const chatRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  // POST /nooks/:nookId/chat — start or continue a conversation
  router.post('/nooks/:nookId/chat', chatRateLimiter, async (req, res) => {
    const cookieHeader = req.headers.cookie ?? '';
    const ok = await verifySession(cookieHeader, apiBase);
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const nook_id = validateNookId(String(req.params.nookId));
    const { message, model, conversation_id, context_note_id, context_note_title, context_note_type } = req.body as Record<string, unknown>;

    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const resolvedModel = typeof model === 'string' && model ? model : DEFAULT_MODEL;

    try {
      // Resolve AI memory nook for storing conversations
      const memoryNookId = await resolveMemoryNookId(cookieHeader, apiBase);
      const convNookId = memoryNookId ?? nook_id;

      // Create or validate conversation
      let convId: string;
      if (typeof conversation_id === 'string' && conversation_id) {
        convId = conversation_id;
      } else {
        const title = message.slice(0, 100);
        const data = await phpApi('POST', '/api/conversations', cookieHeader, apiBase, {
          nook_id: convNookId,
          model: resolvedModel,
          title,
        }) as { conversation: { id: string } };
        convId = data.conversation.id;
      }

      // Build context note from request (no fetch needed — frontend sends title/type)
      const contextNote = (typeof context_note_id === 'string' && context_note_id)
        ? {
            id: context_note_id,
            title: typeof context_note_title === 'string' ? context_note_title : context_note_id,
            type: typeof context_note_type === 'string' ? context_note_type : undefined,
          }
        : undefined;

      // Load history and append new user message
      const history = await loadHistory(convId, cookieHeader, apiBase);
      const userMessage: Anthropic.MessageParam = {
        role: 'user',
        content: [{ type: 'text', text: message }],
      };
      await saveMessages(convId, [{ role: 'user', content: userMessage.content }], cookieHeader, apiBase);
      history.push(userMessage);

      sseHeaders(res);
      sse(res, 'conversation', { conversation_id: convId });

      await streamConversation(res, history, resolvedModel, convId, cookieHeader, apiBase, nook_id, contextNote, memoryNookId);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown error' });
      } else {
        sse(res, 'error', { message: err instanceof Error ? err.message : 'unknown error' });
        res.end();
      }
    }
  });

  // POST /nooks/:nookId/chat/tool-result — user approved or denied tool calls, continue conversation
  router.post('/nooks/:nookId/chat/tool-result', chatRateLimiter, async (req, res) => {
    const cookieHeader = req.headers.cookie ?? '';
    const ok = await verifySession(cookieHeader, apiBase);
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const nook_id = validateNookId(String(req.params.nookId));

    type ToolResult = { tool_use_id: string; tool_name: string; tool_input: Record<string, unknown>; approved: boolean };
    const { conversation_id, model, tool_results, context_note_id, context_note_title, context_note_type } = req.body as {
      conversation_id: string;
      model?: string;
      tool_results: ToolResult[];
      context_note_id?: string;
      context_note_title?: string;
      context_note_type?: string;
    };

    if (!conversation_id || !Array.isArray(tool_results) || tool_results.length === 0) {
      res.status(400).json({ error: 'conversation_id and tool_results are required' });
      return;
    }

    const resolvedModel = typeof model === 'string' && model ? model : DEFAULT_MODEL;

    try {
      // Load full history (includes the assistant message with tool_use blocks)
      const [history, memNookId] = await Promise.all([
        loadHistory(conversation_id, cookieHeader, apiBase),
        resolveMemoryNookId(cookieHeader, apiBase),
      ]);

      // Execute approved tools, build tool_result content blocks
      // Resolve nook name lazily (only if search_agent is among approved tools)
      let cachedNookName: string | undefined;
      const getNookName = async () => {
        if (cachedNookName === undefined) cachedNookName = await resolveNookName(nook_id, cookieHeader, apiBase);
        return cachedNookName;
      };

      const hasSearchAgent = tool_results.some(tr => tr.tool_name === 'search_agent' && tr.approved);
      if (hasSearchAgent) sseHeaders(res);

      // Resolve search agent context lazily
      let searchAgentCtx: SearchAgentContext | undefined;
      const getSearchAgentCtx = async (): Promise<SearchAgentContext> => {
        if (!searchAgentCtx) {
          const [nookInstr, memNotes] = await Promise.all([
            fetchInstructionNotes(nook_id, cookieHeader, apiBase),
            memNookId ? fetchMemoryInstructionNotes(memNookId, cookieHeader, apiBase) : Promise.resolve([]),
          ]);
          const ctxNote = (typeof context_note_id === 'string' && context_note_id)
            ? { id: context_note_id, title: typeof context_note_title === 'string' ? context_note_title : context_note_id, type: typeof context_note_type === 'string' ? context_note_type : undefined }
            : undefined;
          searchAgentCtx = {
            contextNote: ctxNote,
            nookInstructions: nookInstr,
            memoryNotes: memNotes,
            conversationSummary: buildConversationSummary(history),
          };
        }
        return searchAgentCtx;
      };

      const resultBlocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
        tool_results.map(async (tr): Promise<Anthropic.ToolResultBlockParam> => {
          if (!tr.approved) {
            return { type: 'tool_result', tool_use_id: tr.tool_use_id, content: 'User denied this action.' };
          }
          try {
            let result: string;
            if (tr.tool_name === 'search_agent') {
              result = await runSearchAgent(
                String(tr.tool_input.task ?? ''),
                resolvedModel,
                apiBase,
                cookieHeader,
                nook_id,
                await getNookName(),
                memNookId ?? undefined,
                (status) => sse(res, 'search_agent_progress', { tool_use_id: tr.tool_use_id, status }),
                await getSearchAgentCtx(),
              );
            } else {
              result = await executeTool(tr.tool_name, tr.tool_input, apiBase, cookieHeader, nook_id, memNookId ?? undefined);
            }
            return { type: 'tool_result', tool_use_id: tr.tool_use_id, content: result };
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: tr.tool_use_id,
              content: `Error: ${err instanceof Error ? err.message : 'unknown error'}`,
              is_error: true,
            };
          }
        }),
      );

      // Save tool results as a user message
      const toolResultMessage: Anthropic.MessageParam = { role: 'user', content: resultBlocks };
      await saveMessages(
        conversation_id,
        [{ role: 'user', content: resultBlocks }],
        cookieHeader,
        apiBase,
      );
      history.push(toolResultMessage);

      const contextNote = (typeof context_note_id === 'string' && context_note_id)
        ? {
            id: context_note_id,
            title: typeof context_note_title === 'string' ? context_note_title : context_note_id,
            type: typeof context_note_type === 'string' ? context_note_type : undefined,
          }
        : undefined;

      if (!res.headersSent) sseHeaders(res);
      await streamConversation(res, history, resolvedModel, conversation_id, cookieHeader, apiBase, nook_id, contextNote, memNookId);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown error' });
      } else {
        sse(res, 'error', { message: err instanceof Error ? err.message : 'unknown error' });
        res.end();
      }
    }
  });

  return router;
}
