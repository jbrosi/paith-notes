import { Router } from 'express';
import type express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { TOOLS, executeTool } from './chat-tools.js';
import { optionalAutoApprovedTools } from './tools/registry.js';
import { runSearchAgent, type SearchAgentContext } from './search-agent.js';
import { runEditNoteAgent } from './edit-agent.js';
import { VoiceTagStripper, SentenceBuffer } from './voice-tag.js';
import { VoiceStreamer } from './chat/voice.js';
import {
  fetchHandbookNotes,
  fetchInstructionNotes,
  fetchMemoryInstructionNotes,
  type InstructionNote,
  loadHistory,
  phpApi,
  recordNoteConvLink,
  resolveHandbookNookId,
  resolveMemoryNookId,
  resolveNookName,
  saveMessages,
  verifySession,
} from './chat/api.js';
import { buildSystemPrompt } from './chat/system-prompt.js';
import { mapWithConcurrency } from './concurrency.js';

// Cap on parallel tool executions per turn. The Anthropic API encourages
// fan-out (multiple tool_use blocks in one assistant turn), but unbounded
// parallel writes can saturate FrankenPHP workers + the Postgres pool and
// surface as flaky network errors. 3 is conservative — bump if the
// upstream stack grows.
const TOOL_CONCURRENCY = 3;

/**
 * Inject synthetic tool_result blocks for any tool_use that isn't matched
 * by a real result in the immediately-following user message.
 *
 * The Anthropic API requires every tool_use in an assistant turn to be
 * paired with a tool_result in the next user turn — otherwise it 400s.
 * That contract breaks whenever a /chat/tool-result POST never reaches us
 * (network drop, browser tab close, server crash mid-execution): the
 * persisted history ends with assistant{tool_use ...} and the user's next
 * /chat message lands as a plain text user turn, leaving the tool_uses
 * orphaned. Without this fixup, the conversation becomes permanently
 * stuck on a 400 and the user has to start a new chat.
 *
 * We fix this at API-call time only — never write the synthetics back to
 * the DB, so the human-readable transcript stays clean. Idempotent:
 * re-running on already-sanitized history is a no-op (a real tool_result
 * exists, so we don't inject).
 */
export function sanitizeOrphanedToolUses(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const TIMEOUT_MESSAGE =
    'This tool call was interrupted before a result could be returned '
    + '(likely a network drop or session timeout). The action may or may '
    + 'not have actually completed on the server. If continuing depends '
    + 'on knowing the outcome, ask the user to confirm or re-run.';

  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;

    const toolUseIds: string[] = [];
    for (const block of m.content) {
      if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_use' && 'id' in block) {
        toolUseIds.push(String(block.id));
      }
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const matchedIds = new Set<string>();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_result' && 'tool_use_id' in b) {
          matchedIds.add(String(b.tool_use_id));
        }
      }
    }
    const missing = toolUseIds.filter(id => !matchedIds.has(id));
    if (missing.length === 0) continue;

    const syntheticResults: Anthropic.ToolResultBlockParam[] = missing.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: TIMEOUT_MESSAGE,
      is_error: true,
    }));

    if (next && next.role === 'user') {
      // Merge synthetics into the front of the existing user message so the
      // turn alternation stays valid (Anthropic rejects consecutive
      // same-role messages). Normalize string content to a text block.
      const nextContent = Array.isArray(next.content)
        ? next.content
        : [{ type: 'text' as const, text: String(next.content) }];
      out.push({ role: 'user', content: [...syntheticResults, ...nextContent] });
      i++; // skip the original `next`, we just replaced it
    } else {
      // No following user message (or next is an assistant turn — shouldn't
      // happen but be defensive). Insert a standalone user message with the
      // synthetic results so the next assistant turn has its required pair.
      out.push({ role: 'user', content: syntheticResults });
    }
  }
  return out;
}

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

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS    = 8096;
const MAX_AUTO_DEPTH = 8;


// Context window limits per model (input tokens), matching Anthropic's
// documented hard limits. Haiku 4.5 caps at 200K; the 4.6+ generation and
// Sonnet 5 all have 1M-token windows.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
};
// Fall back to Haiku's 200K when we don't recognize the model — the safer
// direction (more, not less, "new chat" pressure) if the model actually
// has a smaller window than we assume.
const DEFAULT_CONTEXT_LIMIT = 200_000;
// Pressure thresholds for 1M-context models. We pay for the big window
// but proactively steer toward new chats — users generally prefer fresh
// context per topic, and the AI's memory tool + save-conversation-to-note
// preserve continuity across chats when it actually matters. Cost isn't
// the driver here; usability is (long chats accumulate stale reasoning,
// harder to recall what was said 200 turns ago, etc).
//
// Behavior:
//   • SOFT (10%, ~100K) — topic-switch-conditional nudge. Once any real
//     conversation has accumulated, offer a fresh start on topic changes.
//   • WARNING (20%, ~200K) — unconditional "consider a new chat" nudge.
//     Meaningful conversation length; save-to-memory prompt starts here.
//   • CRITICAL (40%, ~400K) — strong "you should really start fresh"
//     push. Still leaves 600K headroom for genuine long-form work
//     sessions that need to continue.
const CONTEXT_SOFT_THRESHOLD = 0.10;    // ~100K — topic-switch trigger
const CONTEXT_WARNING_THRESHOLD = 0.20; // ~200K — unconditional suggestion
const CONTEXT_CRITICAL_THRESHOLD = 0.40; // ~400K — strongly encourage new chat

// Tools that are always safe to auto-execute (read-only / non-destructive).
// Core list lives here; optional tool modules contribute their own
// auto-approved names via the registry (e.g. weather + wikipedia).
/**
 * Tools that never execute on the MCP side — they're dispatched back
 * to the frontend, which reads / mutates its live editor buffer and
 * POSTs the actual result via /chat/tool-result with a
 * `frontend_result` field. MCP threads the frontend's answer straight
 * through as the tool_result and continues the Anthropic loop.
 *
 * Kept as a Set so the routing check is O(1) and colocated with the
 * auto-approve list for easy comparison.
 */
const FRONTEND_TOOLS = new Set([
  'get_current_editor',
  'get_current_editor_toc',
  'get_current_editor_part',
  'edit_current_editor',
]);

/**
 * Compact metadata about the user's currently-open editor. Rides on
 * chat POSTs so the AI knows an editor is open and which note it's on
 * — but the actual content stays in the browser and is read/written
 * via the frontend-executed tools above.
 */
type EditorStateMeta =
  | { is_open: true; note_id: string; nook_id: string; title: string; version: number; chars: number }
  | { is_open: false };

function normalizeEditorState(raw: unknown): EditorStateMeta {
  if (typeof raw !== 'object' || raw === null) return { is_open: false };
  const r = raw as Record<string, unknown>;
  if (r.is_open !== true) return { is_open: false };
  const noteId = typeof r.note_id === 'string' ? r.note_id.trim() : '';
  if (!noteId) return { is_open: false };
  return {
    is_open: true,
    note_id: noteId,
    nook_id: typeof r.nook_id === 'string' ? r.nook_id : '',
    title: typeof r.title === 'string' ? r.title : '',
    version: typeof r.version === 'number' ? r.version : 0,
    chars: typeof r.chars === 'number' ? r.chars : 0,
  };
}

const ALWAYS_AUTO_TOOLS = new Set([
  'list_note_types',
  'list_type_attributes',
  'list_link_predicates',
  'get_note_mentions',
  // Read-only, returns just headings (no body, no attributes) — cheap
  // navigation primitive for large notes; safe to auto-approve.
  'get_note_toc',
  // Bounded char-range read of a single note; same trust level as
  // get_note but cheaper. Auto-approve so the AI can navigate big
  // notes without nagging the user for every section read.
  'get_note_part',
  // Find-in-note returns match positions + context only (not the
  // whole note); read-only. Auto-approve.
  'search_in_note',
  'memory_search',
  'memory_get',
  'memory_create',
  'memory_update',
  'ask_user',
  ...optionalAutoApprovedTools,
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
  // Frontend-executed tools are never auto-executed on MCP — they need
  // to be dispatched back to the browser. Explicit false so we don't
  // accidentally add one to ALWAYS_AUTO_TOOLS and end up trying to
  // execute it here.
  if (FRONTEND_TOOLS.has(toolName)) return false;
  if (ALWAYS_AUTO_TOOLS.has(toolName)) return true;
  // get_note is auto-approved for AI instruction notes and search_all_nooks
  if (toolName === 'get_note' && instructionNoteIds && typeof input?.note_id === 'string') {
    if (instructionNoteIds.has(input.note_id)) return true;
  }
  if (toolName === 'search_all_nooks') return true;
  return false;
}


// ─── Message metadata helpers ─────────────────────────────────────────────────

const CONTEXT_NOTE_RE = /\[Note: "[^"]*" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function findPreviousContextNoteId(messages: Anthropic.MessageParam[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
    for (const block of blocks) {
      if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
        const match = CONTEXT_NOTE_RE.exec(String((block as { text: string }).text));
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

function buildMessageText(
  message: string,
  contextNote?: { id: string; title: string; type?: string },
  prevContextNoteId?: string,
  speakerName?: string | null,
  speakerConfidence?: number | null,
): string {
  const ts = new Date().toISOString().slice(0, 16) + 'Z';
  let meta = `[${ts}]`;
  // Per-message speaker attribution — in a living-room kiosk multiple
  // family members can take turns within the same conversation, so
  // attaching the speaker to the conversation (system prompt) misleads
  // the model. We embed the name in the message text itself, in the
  // same bracket-tag pattern as the timestamp; the frontend renders
  // chat messages cleaned of these brackets so the human view stays
  // readable. Confidence is a 0-1 cosine score from the voiceprint
  // match — passed through so Claude can soften the identification
  // when the score is barely above the server-side threshold.
  if (speakerName) {
    const conf =
      typeof speakerConfidence === 'number'
        ? ` (confidence ${speakerConfidence.toFixed(2)})`
        : '';
    meta += ` [spoken by ${speakerName}${conf}]`;
  }
  if (contextNote && contextNote.id !== prevContextNoteId) {
    meta += ` [Note: "${contextNote.title}" (${contextNote.id}, type: ${contextNote.type ?? 'note'})]`;
  }
  return `${meta}\n${message}`;
}

function addCacheBreakpoint(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const lastMsg = msgs[lastIdx];
  const content = Array.isArray(lastMsg.content)
    ? [...lastMsg.content]
    : [{ type: 'text' as const, text: String(lastMsg.content) }];
  if (content.length > 0) {
    content[content.length - 1] = {
      ...(content[content.length - 1] as unknown as Record<string, unknown>),
      cache_control: { type: 'ephemeral' },
    } as (typeof content)[number];
  }
  return [...msgs.slice(0, lastIdx), { ...lastMsg, content }];
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
  voice?: { lang: string } | null,
  editorState?: EditorStateMeta,
): Promise<void> {
  const voiceStreamer = voice ? new VoiceStreamer(res, voice.lang) : null;
  // Terminal events (done/awaiting_approval/error) must be emitted AFTER
  // voiceStreamer.flush() — otherwise the frontend stops reading on the
  // terminal event and the trailing audio_chunk SSE writes (which the
  // flush is still pushing) get stranded in the receive buffer.
  const trailing: Array<{ event: string; data: unknown }> = [];
  // Voice tag stripper + sentence buffer. Together they: (a) strip
  // `<voice instr="...">…</voice>` from the text the user sees in the
  // transcript, (b) pair each spoken sentence with the active instruction
  // (if any) at sentence-start, (c) cope with tags split across token
  // deltas. Both are no-ops when voice mode is off.
  const tagStripper = voiceStreamer ? new VoiceTagStripper() : null;
  const sentenceBuf = voiceStreamer ? new SentenceBuffer() : null;
  const drainVoiceBuf = (): void => {
    if (!voiceStreamer || !sentenceBuf) return;
    for (const s of sentenceBuf.extract()) {
      voiceStreamer.enqueueSentence(s.text, s.instr);
    }
  };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Resolve nook name, role, instruction notes, and handbook in parallel
  let nookName = '';
  let nookRole = '';
  let nookInstructions: InstructionNote[] = [];
  let memoryNotes: InstructionNote[] = [];
  let handbookNookId: string | null = null;
  let handbookNotes: InstructionNote[] = [];

  const [nooksData] = await Promise.all([
    phpApi('GET', '/api/nooks', cookie, apiBase).catch(() => null) as Promise<{ nooks?: Array<{ id: string; name: string; role: string }> } | null>,
    fetchInstructionNotes(nookId, cookie, apiBase).then(r => { nookInstructions = r; }),
    memoryNookId ? fetchMemoryInstructionNotes(memoryNookId, cookie, apiBase).then(r => { memoryNotes = r; }) : Promise.resolve(),
    resolveHandbookNookId(cookie, apiBase).then(async (id) => {
      handbookNookId = id;
      if (id) handbookNotes = await fetchHandbookNotes(id, cookie, apiBase);
    }),
  ]);

  if (nooksData?.nooks) {
    const found = nooksData.nooks.find(n => n.id === nookId);
    nookName = found?.name ?? '';
    nookRole = found?.role ?? '';
  }

  const baseSystemPrompt = buildSystemPrompt(nookId, nookName, nookRole, memoryNookId, nookInstructions, memoryNotes, handbookNookId, handbookNotes, !!voice);
  const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;

  // IDs of instruction notes that can be auto-read without user approval
  const instructionNoteIds = new Set([
    ...nookInstructions.map(n => n.id),
    ...memoryNotes.map(n => n.id),
    ...handbookNotes.map(n => n.id),
  ]);

  // mutable copy we extend on each auto-execute loop. Sanitize first so
  // any orphaned tool_use from a previously-interrupted turn (network
  // drop before the tool_result POST landed) gets a synthetic "timeout"
  // result attached — otherwise the API hard-fails with 400 and the
  // user is stuck unable to continue the conversation.
  const msgs: Anthropic.MessageParam[] = sanitizeOrphanedToolUses([...messages]);
  let lastInputTokens = 0;

  try {
    for (let depth = 0; depth <= MAX_AUTO_DEPTH; depth++) {
      // Build system blocks — base prompt is cached, pressure hint is a separate uncached block
      const systemBlocks: Anthropic.TextBlockParam[] = [
        { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },
      ];
      if (lastInputTokens > 0) {
        const ratio = lastInputTokens / contextLimit;
        // Shared cadence rule for the WARNING/CRITICAL tiers: the AI
        // gets the same hint on every subsequent turn once it fires, so
        // without this it would nag reply-after-reply. Tell it to
        // suggest once, respect the user's choice, and only re-mention
        // periodically as context continues to accumulate.
        const cadenceNote =
          ' If you already suggested a new chat earlier in this conversation and the user chose to continue, respect that — do not repeat the suggestion on every turn. As a rough rhythm, only re-mention it if roughly another 100K tokens have accumulated since your last suggestion, or if the user brings it up.';
        let pressureHint = '';
        if (ratio > CONTEXT_CRITICAL_THRESHOLD) {
          pressureHint =
            '**CRITICAL — Context window is ' + Math.round(ratio * 100) + '% full.** You MUST:\n' +
            '1. Keep responses very concise\n' +
            '2. Strongly encourage the user to start a new chat\n' +
            '3. Offer to summarize key outcomes/decisions into a memory note before they do\n' +
            '4. After saving to memory, tell the user to click "New chat" to continue fresh\n' +
            cadenceNote;
        } else if (ratio > CONTEXT_WARNING_THRESHOLD) {
          pressureHint =
            '**Context window is ' + Math.round(ratio * 100) + '% full.** ' +
            'Suggest starting a new chat soon. Offer to summarize outcomes to memory first. Keep responses concise.' +
            cadenceNote;
        } else if (ratio > CONTEXT_SOFT_THRESHOLD) {
          // SOFT is already self-limiting — its hint is topic-switch-
          // conditional, so it doesn't need the cadence rule.
          pressureHint = '**Context note:** Window is ' + Math.round(ratio * 100) + '% full. If the user switches topics or you sense a natural break, gently suggest starting a new chat. No need to force it.';
        }
        if (pressureHint) systemBlocks.push({ type: 'text', text: pressureHint });
      }

      // Editor state — tell the AI what the user is currently editing.
      // Uncached (fresh per turn) because it changes with every message.
      // Content is NOT included — the AI reads/writes via the
      // get_current_editor / edit_current_editor tools, which round-
      // trip to the frontend for a live answer.
      if (editorState?.is_open) {
        const editorHint =
          `**Editor state:** The user currently has a note open in edit mode:\n` +
          `- note_id: ${editorState.note_id}\n` +
          `- nook_id: ${editorState.nook_id}\n` +
          `- title: ${JSON.stringify(editorState.title)}\n` +
          `- version: ${editorState.version}\n` +
          `- chars: ${editorState.chars}\n\n` +
          `Use get_current_editor / get_current_editor_toc / get_current_editor_part to read the LIVE (in-browser, possibly-unsaved) content. ` +
          `Prefer edit_current_editor over edit_note when editing THIS note — direct disk edits would race with the user's typing. ` +
          `For any other note, use the disk tools (get_note / edit_note) as usual.`;
        systemBlocks.push({ type: 'text', text: editorHint });
      }

      // Add cache breakpoint to last message for conversation history caching
      const cachedMsgs = addCacheBreakpoint(msgs);

      type StoredBlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;
      const contentBlocks: StoredBlock[] = [];
      let currentText = '';
      let currentTool: { id: string; name: string; partialInput: string } | null = null;
      const pendingToolUses: Anthropic.ToolUseBlockParam[] = [];

      const stream = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        tools: TOOLS,
        messages: cachedMsgs,
        system: systemBlocks,
        stream: true,
      });

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;

      for await (const event of stream) {
        if (event.type === 'message_start') {
          const usage = (event as unknown as { message?: { usage?: Record<string, number> } }).message?.usage;
          inputTokens = usage?.input_tokens ?? 0;
          cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
          cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
          lastInputTokens = inputTokens;
        }
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            currentText = '';
          } else if (event.content_block.type === 'tool_use') {
            currentTool = { id: event.content_block.id, name: event.content_block.name, partialInput: '' };
            // Immediately tell the client a tool call is starting so it can show progress
            sse(res, 'tool_use_start', { id: event.content_block.id, name: event.content_block.name });
          }
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            if (voiceStreamer && tagStripper && sentenceBuf) {
              // Run the raw delta through the stripper FIRST so the
              // user-visible delta + the saved transcript stay free of
              // `<voice instr>` wrappers. The stripper also tells us
              // which segment belongs to which active instruction; the
              // sentence buffer then yields complete sentences with the
              // instruction snapshotted at sentence-start.
              const { visible, segments } = tagStripper.push(event.delta.text);
              if (visible) {
                currentText += visible;
                sse(res, 'text_delta', { delta: visible });
              }
              sentenceBuf.pushAll(segments);
              drainVoiceBuf();
            } else {
              currentText += event.delta.text;
              sse(res, 'text_delta', { delta: event.delta.text });
            }
          } else if (event.delta.type === 'input_json_delta' && currentTool) {
            currentTool.partialInput += event.delta.partial_json;
            sse(res, 'tool_input_delta', { id: currentTool.id, delta: event.delta.partial_json });
          }
        }

        if (event.type === 'content_block_stop') {
          if (currentText !== '') {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          // Flush whatever trailing text didn't end with sentence punctuation
          // — the model often ends a turn on a single noun or short clause.
          if (voiceStreamer && tagStripper && sentenceBuf) {
            const tail = tagStripper.flush();
            if (tail.visible) {
              currentText += tail.visible;
              sse(res, 'text_delta', { delta: tail.visible });
            }
            sentenceBuf.pushAll(tail.segments);
            for (const s of sentenceBuf.flush()) {
              voiceStreamer.enqueueSentence(s.text, s.instr);
            }
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
            trailing.push({
              event: 'done',
              data: {
                conversation_id: conversationId,
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  cache_creation_input_tokens: cacheCreationTokens,
                  cache_read_input_tokens: cacheReadTokens,
                  context_limit: contextLimit,
                },
              },
            });
            if (totalTokens > contextLimit * CONTEXT_CRITICAL_THRESHOLD) {
              trailing.push({ event: 'context_warning', data: { level: 'critical', usage_ratio: totalTokens / contextLimit } });
            } else if (totalTokens > contextLimit * CONTEXT_WARNING_THRESHOLD) {
              trailing.push({ event: 'context_warning', data: { level: 'warning', usage_ratio: totalTokens / contextLimit } });
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
              // Auto-execute all tools, loop for next AI turn. Capped at
              // TOOL_CONCURRENCY in-flight to avoid saturating PHP workers.
              const assistantBlocks = savedAssistantTurns[0]?.blocks ?? [];

              const resultBlocks: Anthropic.ToolResultBlockParam[] = await mapWithConcurrency(
                toolsPayload,
                TOOL_CONCURRENCY,
                async (t, i): Promise<Anthropic.ToolResultBlockParam> => {
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
                    } else if (t.name === 'edit_note_agent') {
                      const targetNookId = typeof t.input.nook_id === 'string' && t.input.nook_id.trim() !== ''
                        ? t.input.nook_id.trim() : nookId;
                      const contextMode = t.input.context === 'fresh' ? 'fresh' : 'inherit';
                      resultContent = await runEditNoteAgent({
                        task: String(t.input.task ?? ''),
                        noteId: String(t.input.note_id ?? ''),
                        nookId: targetNookId,
                        contextMode,
                        model,
                        apiBase,
                        cookie,
                        memoryNookId: memoryNookId ?? undefined,
                        onProgress: (status) => sse(res, 'edit_agent_progress', { tool_use_id: t.id, status }),
                        // For inherit mode: hand over the main system prompt
                        // + the message history so the sub-agent inherits the
                        // cached prefix. For fresh mode these are ignored.
                        mainSystemPrompt: baseSystemPrompt,
                        mainMessages: msgs,
                      });
                    } else {
                      resultContent = await executeTool(t.name, t.input, apiBase, cookie, nookId, memoryNookId ?? undefined);
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    // undici/Node's native fetch reports the underlying
                    // network/TLS/DNS failure in `err.cause`, not in
                    // `err.message`. Surface it so we don't have to
                    // guess at "fetch failed" being one of a dozen things.
                    const cause =
                      err instanceof Error && 'cause' in err
                        ? (err as Error & { cause?: unknown }).cause
                        : undefined;
                    const causeStr =
                      cause instanceof Error
                        ? `${cause.name}: ${cause.message}`
                        : cause !== undefined
                          ? String(cause)
                          : '';
                    console.error(
                      `[tool] ${t.name} failed:`, msg,
                      causeStr ? `cause=${causeStr}` : '',
                      'input=', JSON.stringify(t.input).slice(0, 400),
                    );
                    resultContent = `Error: ${msg}${causeStr ? ` (${causeStr})` : ''}`;
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
                },
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
              // Needs user approval OR frontend execution. Frontend
              // tools (get_current_editor / edit_current_editor / …)
              // don't need a UI approval — the frontend answers them
              // silently and POSTs `frontend_result`. We still ride the
              // same `awaiting_approval` SSE + /chat/tool-result plumbing
              // (single-hop back to MCP with the outcomes bundled).
              const frontendExecutedIds = toolsPayload
                .filter(t => FRONTEND_TOOLS.has(t.name))
                .map(t => t.id);
              const displayNames = await resolveDisplayNames(toolsPayload, nookId, apiBase, cookie, memoryNookId);
              trailing.push({
                event: 'awaiting_approval',
                data: {
                  conversation_id: conversationId,
                  tools: toolsPayload,
                  display_names: displayNames,
                  nook_name: nookName,
                  nook_id: nookId,
                  frontend_executed_tool_ids: frontendExecutedIds,
                },
              });
              return;
            }
          }
        }
      }
    }

    // Fell through MAX_AUTO_DEPTH — shouldn't normally happen
    trailing.push({ event: 'error', data: { message: 'Auto-execution depth limit reached' } });
  } catch (err) {
    trailing.push({ event: 'error', data: { message: err instanceof Error ? err.message : 'unknown error' } });
  } finally {
    // Order matters: drain audio_chunks first so the frontend has them all
    // before it sees a terminal event and stops reading. Then emit the
    // captured terminal event(s). Then close the stream.
    if (voiceStreamer) {
      try {
        await voiceStreamer.flush();
      } catch (e) {
        console.error('[voice] flush error', e);
      }
    }
    for (const ev of trailing) sse(res, ev.event, ev.data);
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
    const { message, model, conversation_id, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang, speaker_name, speaker_confidence, editor_state } = req.body as Record<string, unknown>;
    const speakerName =
      typeof speaker_name === 'string' && speaker_name.trim() !== ''
        ? speaker_name.trim()
        : null;
    // Pair the name with its confidence so Claude knows whether to act
    // on identification or treat it as a soft hint. Clamp to a sane
    // range and round so we don't paste arbitrary float precision into
    // the prompt.
    const speakerConfidence =
      typeof speaker_confidence === 'number' && Number.isFinite(speaker_confidence)
        ? Math.max(0, Math.min(1, Math.round(speaker_confidence * 100) / 100))
        : null;

    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const voice = voice_mode === true
      ? { lang: typeof voice_lang === 'string' && voice_lang ? voice_lang : 'en' }
      : null;

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

      // Load history and append new user message with metadata prefix
      const history = await loadHistory(convId, cookieHeader, apiBase);
      const prevContextNoteId = findPreviousContextNoteId(history);
      const messageText = buildMessageText(message as string, contextNote, prevContextNoteId, speakerName, speakerConfidence);
      // Trace: show the metadata prefix MCP just prepended so we can
      // sanity-check that speaker tagging is actually reaching Claude.
      // Logging only the first 200 chars to keep the line readable —
      // the metadata prefix is short and lives at the start.
      console.log(`[chat] user message prefix: ${messageText.slice(0, 200).replace(/\n/g, ' \\n ')}`);
      const userMessage: Anthropic.MessageParam = {
        role: 'user',
        content: [{ type: 'text', text: messageText }],
      };
      await saveMessages(convId, [{ role: 'user', content: userMessage.content }], cookieHeader, apiBase);
      history.push(userMessage);

      sseHeaders(res);
      sse(res, 'conversation', { conversation_id: convId });

      const editorState = normalizeEditorState(editor_state);
      await streamConversation(res, history, resolvedModel, convId, cookieHeader, apiBase, nook_id, contextNote, memoryNookId, voice, editorState);
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

    /**
     * ToolResult shape from the frontend:
     *   - approved: user's approval flag (unchanged from before)
     *   - frontend_result: OPTIONAL, present when the frontend executed
     *     the tool itself (e.g. get_current_editor / edit_current_editor).
     *     When present, MCP uses this directly as the tool_result content
     *     and skips its own execution path. `is_error` lets the frontend
     *     signal a failed edit (not_found / ambiguous) without shape-
     *     matching heuristics on the content string.
     */
    type ToolResult = {
      tool_use_id: string;
      tool_name: string;
      tool_input: Record<string, unknown>;
      approved: boolean;
      frontend_result?: { content: string; is_error?: boolean };
    };
    const { conversation_id, model, tool_results, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang, editor_state } = req.body as {
      conversation_id: string;
      model?: string;
      tool_results: ToolResult[];
      context_note_id?: string;
      context_note_title?: string;
      context_note_type?: string;
      voice_mode?: boolean;
      voice_lang?: string;
      editor_state?: unknown;
    };
    const voice = voice_mode === true
      ? { lang: typeof voice_lang === 'string' && voice_lang ? voice_lang : 'en' }
      : null;

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

      // Execute approved tools with bounded concurrency so a 5-way fan-out
      // doesn't saturate FrankenPHP workers + Postgres connections.
      const resultBlocks: Anthropic.ToolResultBlockParam[] = await mapWithConcurrency(
        tool_results,
        TOOL_CONCURRENCY,
        async (tr): Promise<Anthropic.ToolResultBlockParam> => {
          if (!tr.approved) {
            return { type: 'tool_result', tool_use_id: tr.tool_use_id, content: 'User denied this action.' };
          }
          // Frontend-executed: the browser already ran the tool and
          // baked the result into `frontend_result`. Thread it straight
          // through — MCP does no execution.
          if (tr.frontend_result && typeof tr.frontend_result === 'object') {
            return tr.frontend_result.is_error
              ? { type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.frontend_result.content, is_error: true }
              : { type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.frontend_result.content };
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
            } else if (tr.tool_name === 'edit_note_agent') {
              // Approval flow doesn't have main-loop sys-prompt + msgs in
              // scope (they belong to the streaming endpoint that just
              // ended). Run the agent in fresh-context mode here: the
              // edit cost is still isolated from the main conversation,
              // we just lose the cached-prefix optimization.
              const targetNookId = typeof tr.tool_input.nook_id === 'string'
                && tr.tool_input.nook_id.trim() !== ''
                ? tr.tool_input.nook_id.trim()
                : nook_id;
              result = await runEditNoteAgent({
                task: String(tr.tool_input.task ?? ''),
                noteId: String(tr.tool_input.note_id ?? ''),
                nookId: targetNookId,
                // Forced fresh — we don't have the main conversation's
                // prefix here, and reconstructing it from /messages
                // would double the request cost for marginal benefit
                // (the user is paying through approval anyway).
                contextMode: 'fresh',
                model: resolvedModel,
                apiBase,
                cookie: cookieHeader,
                memoryNookId: memNookId ?? undefined,
                onProgress: (status) => sse(res, 'edit_agent_progress', { tool_use_id: tr.tool_use_id, status }),
              });
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
        },
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
      await streamConversation(res, history, resolvedModel, conversation_id, cookieHeader, apiBase, nook_id, contextNote, memNookId, voice);
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
