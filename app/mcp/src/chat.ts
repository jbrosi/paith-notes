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
import { stripStaleImageBlocks } from './chat/image-budget.js';
import {
  computeContextBreakdown,
  formatBreakdown,
  isDebugContextEnabled,
} from './chat/context-debug.js';
import { mapWithConcurrency } from './concurrency.js';
import { decodeImage, resizeForVision } from './image-resize.js';
import { clearTurnImages, parkedToolsNeedImages, setTurnImages } from './turn-images.js';
import { storeAttachments, type StoredAttachment } from './chat-attachments.js';
import { modelSupportsVision } from './vision-model.js';
import type { ToolResultContent } from './tools/types.js';

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

const DEFAULT_MODEL = 'paith-low';
const MAX_TOKENS    = 8096;
const MAX_AUTO_DEPTH = 8;

// Vision capability lives in vision-model.ts (see the note there about import
// cycles); re-exported here because callers historically imported it from
// this module.
export { modelSupportsVision };

// One attached image, as sent by the frontend. `data` is a full data: URI
// (data:image/jpeg;base64,…) or a raw base64 string — the ORIGINAL, full-res
// bytes. `media_type` is the source mime (image/png | image/jpeg | …). Node
// resizes on demand for vision (see image-resize.ts) and passes the original
// straight to PHP for saving. The model never carries the bytes itself.
type ChatImage = {
  data: string;
  media_type?: string;
};

const MAX_CHAT_IMAGES = 4;
// Last-resort cap so a hand-crafted POST can't ship an unbounded base64 blob.
const MAX_IMAGE_BASE64_CHARS = 20_000_000;

export function normalizeChatImage(raw: unknown): ChatImage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const data = typeof r.data === 'string' ? r.data.trim() : '';
  const mediaType = typeof r.media_type === 'string' ? r.media_type.trim() : '';
  if (!data) return null;
  if (data.length > MAX_IMAGE_BASE64_CHARS) return null;
  return { data, media_type: mediaType || undefined };
}

/**
 * Build the Anthropic `image` content block for the VISION call by resizing
 * the original bytes with sharp. Returns null if the resize fails (the image
 * is then just unavailable for vision — saving still works off the original).
 */
export async function imageToBlock(img: ChatImage): Promise<Anthropic.ImageBlockParam | null> {
  try {
    const resized = await resizeForVision(img.data);
    return {
      type: 'image',
      source: { type: 'base64', media_type: resized.mediaType, data: resized.base64 },
    };
  } catch (err) {
    // Never fail silently. A swallowed resize leaves the model with an
    // [IMAGE n] reference and no pixels, which is exactly how you get a
    // confident hallucination — the caller can't warn it either, since the
    // only signal it gets is the null.
    console.warn(
      '[chat] vision resize FAILED (model will not see this image, saving still works):',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return null;
  }
}

export type ThinkingLevel = 'off' | 'low' | 'high';
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high'];
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
}

// Models that are real Anthropic Claude endpoints (vs. local/proxied
// stand-ins). Extended-thinking parameter handling differs per backend;
// the qwen3.8 route is the only one we actively enable thinking on.
function isLegacyClaudeModel(model: string): boolean {
  return model.startsWith('claude-');
}

// Models supported by the chat UI + their context windows (input tokens).
// Local-model deployments: ANTHROPIC_BASE_URL points at a LiteLLM proxy that
// aliases these names (see .env.example). Context limits below are the
// backend's real windows — CHAT_CONTEXT_LIMIT still overrides them.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Both local models are Qwen-family with 256K (262,144) native context:
  // paith-low is the 9B (Qwen3.5-9B fine-tune), paith-high the 27B.
  'paith-low': 262_144,
  'paith-high': 262_144,
  // Legacy Claude aliases stay resolvable so existing saved conversations
  // and tests keep their documented windows.
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

// Operator override for when ANTHROPIC_BASE_URL points at a proxy — e.g.
// LiteLLM in front of a local model — whose real window differs from the
// model's default. PER-MODEL: a single global number can't be right for two
// local models with different real windows (paith-low=32K vs paith-high=262K),
// so each model has its own override (CHAT_CTX_<UPPER_SNAKE_NAME>) plus a
// global CHAT_CONTEXT_LIMIT as a last-resort fallback for unknown models.
export function parseContextLimit(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function contextOverrideKey(model: string): string {
  // CHAT_CTX_<name> with the model name upper-cased and non-alphanumerics
  // turned into underscores — e.g. paith-low -> CHAT_CTX_PAITH_LOW,
  // qwen3.8:27b-mtp-q4_K_M -> CHAT_CTX_QWEN3_8_27B_MTP_Q4_K_M.
  return 'CHAT_CTX_' + model.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function contextLimitFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // 1. Per-model override (CHAT_CTX_<name>) — most specific.
  // 2. The model's table value (its real/default window).
  // 3. Global CHAT_CONTEXT_LIMIT — last resort, only for unknown models.
  // 4. 200K default.
  return (
    parseContextLimit(env[contextOverrideKey(model)])
    ?? MODEL_CONTEXT_LIMITS[model]
    ?? parseContextLimit(env.CHAT_CONTEXT_LIMIT)
    ?? DEFAULT_CONTEXT_LIMIT
  );
}
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
  // Editor bridges — read/write the user's live in-browser buffer.
  'get_current_editor',
  'get_current_editor_toc',
  'get_current_editor_part',
  'edit_current_editor',
  // Generic browser-API bridges — everything below rides the same
  // frontend-executed dispatch flow (SSE awaiting_approval → frontend
  // executes → POST /chat/tool-result with frontend_result). Same
  // pattern as the editor tools; the frontend just calls a different
  // navigator/window API.
  'get_current_location',
  'get_current_selection',
  'read_clipboard',
  'get_client_info',
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

// Empty string is a valid input — represents "no nook selected" (nook-independent chat).
// Downstream code treats empty nookId as "cross-nook / memory tools only" and gates
// nook-scoped tools with a clear error.
function validateNookId(nookId: string): string {
  if (nookId === '') return '';
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

// Tools that still prompt by default, but auto-execute when the nook owner set
// ai_mode = 'auto_reads'. Scoped to the current nook only (a read aimed at
// another nook still prompts — it may be stricter/disabled). UI side effects
// (open_note) and every write stay gated. search_agent is included: it is
// read-only and current-nook-scoped (it strips nook_id and can't search other
// nooks), so "trust reads on this nook" covers it — it just runs a sub-agent
// (extra inference, negligible on self-hosted models). Always-auto read
// primitives are already covered by ALWAYS_AUTO_TOOLS.
const AUTO_READS_TOOLS = new Set([
  'get_note',
  'get_note_history',
  'get_note_version',
  'compare_note_versions',
  'get_note_summary',
  'get_note_section',
  'read_note_lines',
  'search_notes',
  'search_notes_batch',
  'explore_notes',
  'search_agent',
]);

// Writes whose effects can depend on each other within one turn — e.g. create a
// note then link to it, or edit two notes that link to each other. Running them
// in parallel races: a dependent call can hit the DB before the call it relies
// on has committed ("note not found"). These execute SEQUENTIALLY in the order
// the model emitted them; every other tool (reads, search_agent) still fans out.
const ORDER_SENSITIVE_WRITE_TOOLS = new Set([
  'create_note',
  'update_note',
  'delete_note',
  'edit_note',
  'edit_note_agent',
  'create_note_link',
  'delete_note_link',
  'create_note_type',
  'update_note_type',
  'generate_image',
  'save_image_to_note',
  'memory_create',
  'memory_update',
]);

export function isAutoExecutable(
  toolName: string,
  input?: Record<string, unknown>,
  instructionNoteIds?: Set<string>,
  aiMode?: string,
  currentNookId?: string,
): boolean {
  // Frontend-executed tools are never auto-executed on MCP — they need
  // to be dispatched back to the browser. Explicit false so we don't
  // accidentally add one to ALWAYS_AUTO_TOOLS and end up trying to
  // execute it here.
  if (FRONTEND_TOOLS.has(toolName)) return false;
  if (ALWAYS_AUTO_TOOLS.has(toolName)) return true;
  // get_note is auto-approved only for AI instruction / handbook notes.
  if (toolName === 'get_note' && instructionNoteIds && typeof input?.note_id === 'string') {
    if (instructionNoteIds.has(input.note_id)) return true;
  }
  // Cross-nook interactions (search_all_nooks) ALWAYS require human approval —
  // even under auto_reads. The user consented to reads on *this* nook, not to
  // the AI reaching across nook boundaries into others.
  // Owner set this nook to auto-approve reads: run read-only tools scoped to
  // THIS nook without an approval card. A read targeting a different nook still
  // prompts (that nook may be stricter or disabled).
  if (aiMode === 'auto_reads' && AUTO_READS_TOOLS.has(toolName)) {
    const target = typeof input?.nook_id === 'string' && input.nook_id.trim() !== ''
      ? input.nook_id.trim()
      : currentNookId;
    if (target !== undefined && target === currentNookId) return true;
  }
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

// Append per-turn context (window-pressure nudge, editor state) to the LAST
// message as a trailing text block. Call AFTER addCacheBreakpoint so the hint
// lands past the cache breakpoint: the cached [system + history] prefix stays
// byte-identical between turns, and only this small tail (plus the reply) falls
// outside the cache — instead of every per-turn change invalidating the whole
// conversation from the system prompt onward. Not persisted (operates on the
// outgoing copy). No-op if there's no hint or the tail isn't a user turn.
export function appendTurnHint(msgs: Anthropic.MessageParam[], hint: string): Anthropic.MessageParam[] {
  if (!hint || msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const lastMsg = msgs[lastIdx];
  if (lastMsg.role !== 'user') return msgs;
  const content = Array.isArray(lastMsg.content)
    ? [...lastMsg.content]
    : [{ type: 'text' as const, text: String(lastMsg.content) }];
  content.push({ type: 'text', text: hint });
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
  thinking?: ThinkingLevel,
  visionHint?: string,
): Promise<{ needsImages: boolean }> {
  const voiceStreamer = voice ? new VoiceStreamer(res, voice.lang) : null;
  // Terminal events (done/awaiting_approval/error) must be emitted AFTER
  // voiceStreamer.flush() — otherwise the frontend stops reading on the
  // terminal event and the trailing audio_chunk SSE writes (which the
  // flush is still pushing) get stranded in the receive buffer.
  const trailing: Array<{ event: string; data: unknown }> = [];
  // True when this turn parked on an approval card instead of finishing. The
  // approved tools run in a SEPARATE request (POST /chat/tool-result), so the
  // per-turn image stash must outlive this stream — otherwise a tool that
  // needs approval (save_image_to_note is a write, so it always does) would
  // find its [IMAGE n] bytes already deleted and could never succeed. The
  // tool-result route clears the stash instead; the 10-min TTL in
  // turn-images.ts backstops an approval the user never answers.
  let parkedOnApproval = false;
  // Which tools the turn parked on. Only tools that resolve bytes out of the
  // turn stash matter for its lifetime (today: save_image_to_note).
  let parkedNeedsImages = false;
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
  let thinkingDeltaSeen = false;
  console.log(
    `[chat] request: model=${model} thinking=${thinking ?? 'off'} base=${process.env.ANTHROPIC_BASE_URL || '(default api.anthropic.com)'} ` +
    `keySet=${process.env.ANTHROPIC_API_KEY ? 'yes' : 'no'} ` +
    `msgs=${messages.length} contextLimit=${contextLimitFor(model)}`,
  );

  // Resolve nook name, role, instruction notes, and handbook in parallel
  let nookName = '';
  let nookRole = '';
  let nookAiMode = '';
  let nookInstructions: InstructionNote[] = [];
  let memoryNotes: InstructionNote[] = [];
  let handbookNookId: string | null = null;
  let handbookNotes: InstructionNote[] = [];

  const [nooksData] = await Promise.all([
    phpApi('GET', '/api/nooks', cookie, apiBase).catch(() => null) as Promise<{ nooks?: Array<{ id: string; name: string; role: string; ai_mode?: string }> } | null>,
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
    nookAiMode = found?.ai_mode ?? '';
  }

  const baseSystemPrompt = buildSystemPrompt(nookId, nookName, nookRole, memoryNookId, nookInstructions, memoryNotes, handbookNookId, handbookNotes, !!voice, nookAiMode);
  const contextLimit = contextLimitFor(model);

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
  const msgs: Anthropic.MessageParam[] = sanitizeOrphanedToolUses(
    // Bound re-sent pixels too: look_at_image results are persisted, so an
    // old image block would otherwise ride along on every later turn forever.
    // Request-time only — the DB keeps the full transcript.
    stripStaleImageBlocks([...messages]),
  );
  let lastInputTokens = 0;

  try {
    for (let depth = 0; depth <= MAX_AUTO_DEPTH; depth++) {
      // The system prompt is a STABLE cached prefix — nothing per-turn goes
      // here. System precedes every message, so a per-turn edit here would
      // invalidate the KV/prompt cache for the ENTIRE conversation each turn.
      const systemBlocks: Anthropic.TextBlockParam[] = [
        { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },
      ];

      // Per-turn context (window-pressure nudge + editor state) rides on the
      // TAIL of the current user turn instead (see appendTurnHint below) so the
      // cached [system + history] prefix stays byte-identical between turns.
      const turnHintParts: string[] = [];
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
        if (pressureHint) turnHintParts.push(pressureHint);
      }

      // Editor state — tell the AI what the user is currently editing. Changes
      // with every message, hence the tail (not the cached system prompt).
      // Content is NOT included — the AI reads/writes via the
      // get_current_editor / edit_current_editor tools, which round-
      // trip to the frontend for a live answer.
      if (editorState?.is_open) {
        turnHintParts.push(
          `**Editor state:** The user currently has a note open in edit mode:\n` +
          `- note_id: ${editorState.note_id}\n` +
          `- nook_id: ${editorState.nook_id}\n` +
          `- title: ${JSON.stringify(editorState.title)}\n` +
          `- version: ${editorState.version}\n` +
          `- chars: ${editorState.chars}\n\n` +
          `Use get_current_editor / get_current_editor_toc / get_current_editor_part to read the LIVE (in-browser, possibly-unsaved) content. ` +
          `Prefer edit_current_editor over edit_note when editing THIS note — direct disk edits would race with the user's typing. ` +
          `For any other note, use the disk tools (get_note / edit_note) as usual.`,
        );
      }

      // Vision gating — the user attached image(s) but the current model can't
      // see them (they were dropped, not sent to the API). Instruct the model to
      // ask the user to switch to the vision-capable model and re-send. Only
      // present on the single turn where the drop happened.
      if (visionHint) {
        turnHintParts.push(visionHint);
      }

      const turnHint = turnHintParts.length
        ? `[SYSTEM CONTEXT for this turn — guidance only, not written by the user; don't quote it back]\n\n${turnHintParts.join('\n\n')}`
        : '';

      // Cache breakpoint on the persisted history tail, THEN append the
      // volatile per-turn hint after it (uncached, unpersisted).
      const cachedMsgs = appendTurnHint(addCacheBreakpoint(msgs), turnHint);

      // Extended thinking (off/low/high) — sent only for levels the
      // backend model supports. Qwen3.8 (via the LiteLLM/Ollama proxy)
      // exposes a "thinking" capability; "low" and "high" map to a
      // small vs. generous reasoning budget. "off" (default) and any
      // backend that rejects the parameter fall through to no thinking.
      const thinkingParam =
        thinking && thinking !== 'off' && !isLegacyClaudeModel(model)
          ? {
              type: 'enabled' as const,
              budget_tokens: thinking === 'high' ? 4096 : 1024,
            }
          : undefined;

      type StoredBlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;
      const contentBlocks: StoredBlock[] = [];
      let currentText = '';
      let currentTool: { id: string; name: string; partialInput: string } | null = null;
      const pendingToolUses: Anthropic.ToolUseBlockParam[] = [];

      // Optional context-window breakdown (gated on CHAT_DEBUG_CONTEXT).
      // Uses the backend's own tokenizer via LiteLLM's count_tokens endpoint
      // so the numbers match what the window actually holds — important on
      // Ollama where the count differs from Anthropic's. Adds one count call
      // per message prefix; only runs when the debug flag is on.
      let contextBreakdown: Awaited<ReturnType<typeof computeContextBreakdown>> | null = null;
      if (isDebugContextEnabled()) {
        try {
          contextBreakdown = await computeContextBreakdown(
            process.env.ANTHROPIC_BASE_URL ?? '',
            process.env.ANTHROPIC_API_KEY ?? '',
            model,
            baseSystemPrompt,
            TOOLS,
            cachedMsgs,
          );
          console.log(formatBreakdown(contextBreakdown));
        } catch (err) {
          console.warn('[ctx] breakdown failed:', err instanceof Error ? err.message : err);
        }
      }

      const stream = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        tools: TOOLS,
        messages: cachedMsgs,
        system: systemBlocks,
        stream: true,
        ...(thinkingParam ? { thinking: thinkingParam, tool_choice: { type: 'auto' } } : {}),
      });
      console.log('[chat] stream established — first events incoming');

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
          } else if (event.delta.type === 'thinking_delta') {
            // Extended-thinking reasoning stream. For stateless local
            // backends (qwen3.8 via LiteLLM/Ollama) this is a fresh
            // computation each call — show it live in the UI but do NOT
            // persist it (it would mislead on re-reads and add noise).
            if (!thinkingDeltaSeen) {
              thinkingDeltaSeen = true;
              console.log(`[chat] thinking_delta events received (thinking=${thinking ?? 'off'}) — forwarding to UI`);
            }
            sse(res, 'thinking_delta', { delta: event.delta.thinking });
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
          // message_delta usage is cumulative for the whole message. Anthropic
          // already sent input/cache counts in message_start, but proxies like
          // LiteLLM send zeros there and only know the real counts here.
          const usage = event.usage;
          outputTokens = usage.output_tokens ?? outputTokens;
          if (usage.input_tokens != null && usage.input_tokens > 0) {
            inputTokens = usage.input_tokens;
            lastInputTokens = inputTokens;
          }
          cacheCreationTokens = usage.cache_creation_input_tokens ?? cacheCreationTokens;
          cacheReadTokens = usage.cache_read_input_tokens ?? cacheReadTokens;

          // Per-round-trip usage so the UI can show tokens per assistant
          // message and keep a running conversation total. Fires for every
          // turn (tool_use round-trips included), not only the final one —
          // the `done` event alone would drop every intermediate call.
          sse(res, 'turn_usage', {
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_creation_input_tokens: cacheCreationTokens,
              cache_read_input_tokens: cacheReadTokens,
              context_limit: contextLimitFor(model),
            },
            // Per-component context breakdown — only populated when
            // CHAT_DEBUG_CONTEXT is on. Lets the UI show exactly where the
            // window is going (system / tools / each message / tool_results)
            // instead of one opaque total.
            ...(contextBreakdown
              ? {
                  context_breakdown: {
                    system_tokens: contextBreakdown.systemTokens,
                    tools_tokens: contextBreakdown.toolsTokens,
                    total_tokens: contextBreakdown.totalTokens,
                    messages: contextBreakdown.messages,
                    biggest: contextBreakdown.biggest,
                  },
                }
              : {}),
          });

          const stopReason = event.delta.stop_reason;

          const savedAssistantTurns = await saveMessages(
            conversationId,
            [{ role: 'assistant', content: contentBlocks, model }],
            cookie,
            apiBase,
          );

          if (stopReason === 'end_turn') {
            const contextLimit = contextLimitFor(model);
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
            return { needsImages: false };
          }

          if (stopReason === 'tool_use') {
            // Check if all tools can be auto-executed
            const toolsPayload = pendingToolUses.map(t => ({
              id: t.id,
              name: t.name,
              input: t.input as Record<string, unknown>,
            }));

            if (toolsPayload.every(t => isAutoExecutable(t.name, t.input, instructionNoteIds, nookAiMode, nookId))) {
              // Auto-execute all tools, loop for next AI turn. Capped at
              // TOOL_CONCURRENCY in-flight to avoid saturating PHP workers.
              const assistantBlocks = savedAssistantTurns[0]?.blocks ?? [];

              const resultBlocks: Anthropic.ToolResultBlockParam[] = await mapWithConcurrency(
                toolsPayload,
                TOOL_CONCURRENCY,
                async (t, i): Promise<Anthropic.ToolResultBlockParam> => {
                  let resultContent: ToolResultContent;
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
                        thinking,
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
                        thinking,
                      });
                    } else {
                      resultContent = await executeTool(t.name, t.input, apiBase, cookie, nookId, memoryNookId ?? undefined, conversationId, model);
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
                      if (typeof resultContent === 'string') {
                        const resultData = JSON.parse(resultContent) as { note?: { id?: string } };
                        const noteId = resultData.note?.id;
                        if (noteId) {
                          const savedBlock = assistantBlocks.find((b) => b.toolUseId === t.id);
                          await recordNoteConvLink(noteId, conversationId, savedBlock?.id, apiBase, cookie);
                        }
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
              parkedOnApproval = true;
              parkedNeedsImages = parkedToolsNeedImages(toolsPayload.map((t) => t.name));
              return { needsImages: parkedNeedsImages };
            }
          }
        }
      }
    }

    // Fell through MAX_AUTO_DEPTH — shouldn't normally happen
    trailing.push({ event: 'error', data: { message: 'Auto-execution depth limit reached' } });
  } catch (err) {
    // Log server-side too — the error only reaches the user as an SSE
    // event, and API failures (bad key, unreachable proxy, unknown model)
    // otherwise leave zero trace in container logs.
    const cause =
      err instanceof Error && 'cause' in err
        ? (err as Error & { cause?: unknown }).cause
        : undefined;
    const causeStr = cause instanceof Error ? `${cause.name}: ${cause.message}` : typeof cause === 'string' ? cause : '';
    console.error(
      `[chat] stream failed:`, err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      causeStr ? `(cause: ${causeStr})` : '',
    );
    trailing.push({ event: 'error', data: { message: err instanceof Error ? err.message : 'unknown error' } });
  } finally {
    // Release this turn's attached-image bytes now that the stream is over —
    // save_image_to_note has already had its chance to read them. When we
    // parked on an approval card the turn isn't over: those tools execute in
    // the /chat/tool-result request, so keep the stash until it lands.
    if (!parkedOnApproval) {
      clearTurnImages(conversationId);
    }
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
  return { needsImages: parkedOnApproval && parkedNeedsImages };
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

  // POST /nooks/:nookId/chat or /chat — start or continue a conversation.
  // The nook-independent /chat variant is used by the frontend when no nook
  // is selected; downstream code handles empty nookId as "cross-nook only".
  router.post(['/nooks/:nookId/chat', '/chat'], chatRateLimiter, async (req, res) => {
    const cookieHeader = req.headers.cookie ?? '';
    const ok = await verifySession(cookieHeader, apiBase);
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const nook_id = validateNookId(String(req.params.nookId ?? ''));
    const { message, model, images, conversation_id, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang, speaker_name, speaker_confidence, editor_state, thinking } = req.body as Record<string, unknown>;
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

    const imagesRaw = Array.isArray(images) ? images : [];
    if ((typeof message !== 'string' || message.trim() === '') && imagesRaw.length === 0) {
      res.status(400).json({ error: 'message or images is required' });
      return;
    }
    const voice = voice_mode === true
      ? { lang: typeof voice_lang === 'string' && voice_lang ? voice_lang : 'en' }
      : null;

    const resolvedModel = typeof model === 'string' && model ? model : DEFAULT_MODEL;
    const resolvedThinking: ThinkingLevel = isThinkingLevel(thinking) ? thinking : 'off';

    try {
      // Resolve AI memory nook for storing conversations
      const memoryNookId = await resolveMemoryNookId(cookieHeader, apiBase);
      const convNookId = memoryNookId ?? nook_id;
      if (!convNookId) {
        // No selected nook AND no memory nook — nothing owns the conversation record.
        res.status(400).json({ error: 'AI memory nook is unavailable — cannot start a chat without a nook context.' });
        return;
      }

      // Create or validate conversation
      let convId: string;
      if (typeof conversation_id === 'string' && conversation_id) {
        convId = conversation_id;
      } else {
        const title = (typeof message === 'string' ? message : '').slice(0, 100);
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

      // Attached images — the ORIGINAL full-res bytes arrive once. Node routes
      // them three ways:
      //   VISION → resized on the fly (sharp) into an `image` block the model
      //            sees. Only for vision-capable models (otherwise the backend
      //            500s). The resized copy is what's persisted + sent to the LLM.
      //   SAVING → the ORIGINAL stays in MCP scope; the model only ever holds a
      //            small [IMAGE n] id, never bytes.
      //   DURABILITY → the ORIGINAL is uploaded to the attachment store, so it
      //            survives the turn, the process and a reload. That's what makes
      //            "analyse it now, save it later" and "look at it again" work.
      const normalized = imagesRaw
        .slice(0, MAX_CHAT_IMAGES)
        .map(normalizeChatImage)
        .filter((b): b is ChatImage => b !== null);
      const vision = modelSupportsVision(resolvedModel);

      // Persist the originals BEFORE anything else so the ids exist even if the
      // resize later fails — saving and re-looking must not depend on vision.
      // A failed upload is non-fatal: we fall back to the per-turn in-memory
      // stash so the user can still save the image in THIS turn.
      let attachments: StoredAttachment[] = [];
      if (normalized.length > 0) {
        try {
          attachments = await storeAttachments(convId, normalized, {
            apiBase: apiBase,
            cookie: cookieHeader,
            ...(nook_id ? { nookId: nook_id } : {}),
          });
          console.log(
            `[chat] stored ${attachments.length}/${normalized.length} attachment(s) for conversation ${convId}`
            + ` (${attachments.map((a) => `[IMAGE ${a.attachment_index}]=${a.id}`).join(' ')})`,
          );
        } catch (err) {
          console.warn(
            '[chat] attachment store FAILED — images stay usable this turn only (saving later / re-looking '
            + 'will not work):',
            err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          );
        }
      }

      const imageBlocks = vision
        ? (await Promise.all(normalized.map(imageToBlock)))
            .filter((b): b is Anthropic.ImageBlockParam => b !== null)
        : [];
      const hasImages = normalized.length > 0;
      // What the model can actually SEE is what survived the resize — not what
      // was attached. A vision model whose resizes all failed (e.g. sharp has no
      // native binary on this platform) is just as blind as a text-only model,
      // and must be told so or it will invent a description.
      const visibleCount = imageBlocks.length;
      const blindCount = normalized.length - visibleCount;
      if (hasImages) {
        console.log(
          `[chat] ${normalized.length} image(s) attached — vision=${vision} visible=${visibleCount} blind=${blindCount} (save always available)`,
        );
      }

      // [IMAGE n] marker (NO bytes) so the model can reference an attached image
      // for save_image_to_note / look_at_image. The bytes never travel through
      // the LLM. When the attachment store took the upload we hand out durable
      // ids; otherwise we fall back to the [IMAGE n] index of this turn.
      const imageReferences = hasImages
        ? (attachments.length === normalized.length
            ? attachments.map((a) => `[IMAGE ${a.attachment_index}] id=${a.id}`)
            : normalized.map((_, i) => `[IMAGE ${i + 1}] (this turn only — the attachment store is unavailable, so it cannot be saved later or re-viewed)`)
          ).join('\n')
        : '';
      const userText =
        (messageText.trim() ? messageText : '') +
        (hasImages
          ? '\n\nAttached image(s):\n' +
            imageReferences +
            '\n\nThe ids stay valid for the whole conversation, so you can keep referring to them in later '
            + 'messages. To SAVE one, call save_image_to_note with attachment_id = that id (plus a title, or '
            + 'note_id to attach). Saving works on every model — it does not require vision. To actually SEE '
            + 'one (including an image from an earlier message, or an image saved in a note), call look_at_image.'
          : '');

      const userContent: Anthropic.ContentBlockParam[] = [
        { type: 'text', text: userText },
        ...imageBlocks,
      ];
      const userMessage: Anthropic.MessageParam = {
        role: 'user',
        content: userContent,
      };
      await saveMessages(convId, [{ role: 'user', content: userMessage.content }], cookieHeader, apiBase);
      history.push(userMessage);

      // Stash the ORIGINAL bytes for this turn so save_image_to_note can pull
      // them by index. Scope = the single /chat call (cleared when it returns).
      setTurnImages(convId, normalized);

      sseHeaders(res);
      sse(res, 'conversation', { conversation_id: convId });

      const editorState = normalizeEditorState(editor_state);
      // Warn the model about every attachment it cannot SEE. Two distinct
      // causes, and the model must be told in both — otherwise it answers from
      // imagination rather than saying "I can't see that":
      //   a) the active model has no vision at all (paith-low)
      //   b) the model is vision-capable but the image failed to decode/resize
      // Every attachment remains saveable either way.
      const visionHintParts: string[] = [];
      if (hasImages && !vision) {
        visionHintParts.push(
          'The user attached image(s) to this message, but the current model (' + resolvedModel + ') has NO vision — you cannot see or describe the image contents. Two things are still possible:\n' +
            '1. SAVE it: call save_image_to_note with attachment_id = the id from the [IMAGE n] id=<uuid> marker (plus a title, or note_id to attach to an existing note). This does NOT require vision.\n' +
            '2. DESCRIBE it: not possible here. look_at_image will refuse on this model, so if the user asks what\'s in the image, tell them this model can\'t see images and suggest switching to "Paith High" (vision-capable) — the attachment stays stored, so they do NOT need to re-send it. Do NOT guess or describe the image content.',
        );
      } else if (blindCount > 0) {
        visionHintParts.push(
          visibleCount === 0
            ? 'IMPORTANT: image(s) were attached to this message, but NONE of them could be decoded for viewing (a server-side image-processing failure — not a vision limitation of the model). You are therefore completely BLIND to them this turn. If the user asks what an image shows, tell them plainly that the image could not be processed and you cannot see it, and offer to save it instead. Do NOT guess, describe, or infer the contents — an honest "I can\'t see this one" is correct here.'
            : `IMPORTANT: ${visibleCount} of the ${hasImages} attached image(s) could not be decoded for viewing (a server-side image-processing failure). You can see the others, but you are BLIND to the remaining ${blindCount}. Never describe or guess at those. Say the image couldn't be processed, and offer to save it instead.`,
        );
      }
      const visionHint = visionHintParts.join('\n\n');
      const outcome = await streamConversation(res, history, resolvedModel, convId, cookieHeader, apiBase, nook_id, contextNote, memoryNookId, voice, editorState, resolvedThinking, visionHint);
      // If the turn parked on tools that don't read image bytes, nothing will
      // ever come back for them — drop the stash now rather than let it sit
      // until the TTL. (streamConversation already cleared it when the turn
      // didn't park at all; this is the parked case.)
      if (!outcome.needsImages) {
        clearTurnImages(convId);
      }
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
  router.post(['/nooks/:nookId/chat/tool-result', '/chat/tool-result'], chatRateLimiter, async (req, res) => {
    const cookieHeader = req.headers.cookie ?? '';
    const ok = await verifySession(cookieHeader, apiBase);
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const nook_id = validateNookId(String(req.params.nookId ?? ''));

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
    const { conversation_id, model, tool_results, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang, editor_state, thinking } = req.body as {
      conversation_id: string;
      model?: string;
      tool_results: ToolResult[];
      context_note_id?: string;
      context_note_title?: string;
      context_note_type?: string;
      voice_mode?: boolean;
      voice_lang?: string;
      editor_state?: unknown;
      thinking?: string;
    };
    const voice = voice_mode === true
      ? { lang: typeof voice_lang === 'string' && voice_lang ? voice_lang : 'en' }
      : null;

    if (!conversation_id || !Array.isArray(tool_results) || tool_results.length === 0) {
      res.status(400).json({ error: 'conversation_id and tool_results are required' });
      return;
    }

    const resolvedModel = typeof model === 'string' && model ? model : DEFAULT_MODEL;
    const resolvedThinking: ThinkingLevel = isThinkingLevel(thinking) ? thinking : 'off';

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

      // Execute approved tools. Reads fan out (bounded so a 5-way fan-out
      // doesn't saturate FrankenPHP workers + Postgres); order-sensitive writes
      // run sequentially in the order the model emitted them, so a create→link
      // (or edits + links on related notes) can't race with what it depends on.
      // Results are placed back by index, so tool_result order is preserved.
      const execApprovedTool = async (tr: ToolResult): Promise<Anthropic.ToolResultBlockParam> => {
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
            let result: ToolResultContent;
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
                resolvedThinking,
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
                thinking: resolvedThinking,
              });
            } else {
              result = await executeTool(
                tr.tool_name,
                tr.tool_input,
                apiBase,
                cookieHeader,
                nook_id,
                memNookId ?? undefined,
                conversation_id,
                // The approved tool runs in THIS request, so the vision gate in
                // look_at_image has to see the model the turn was resolved to.
                resolvedModel,
              );
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
      };

      const resultBlocks: Anthropic.ToolResultBlockParam[] = new Array(tool_results.length);
      const readIdx: number[] = [];
      const writeIdx: number[] = [];
      tool_results.forEach((tr, i) => {
        (ORDER_SENSITIVE_WRITE_TOOLS.has(tr.tool_name) ? writeIdx : readIdx).push(i);
      });
      // Reads fan out…
      await mapWithConcurrency(readIdx, TOOL_CONCURRENCY, async (i) => {
        resultBlocks[i] = await execApprovedTool(tool_results[i]);
      });
      // …order-sensitive writes run strictly in the model's emitted order.
      for (const i of writeIdx) {
        resultBlocks[i] = await execApprovedTool(tool_results[i]);
      }

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
      const outcome = await streamConversation(res, history, resolvedModel, conversation_id, cookieHeader, apiBase, nook_id, contextNote, memNookId, voice, undefined, resolvedThinking);
      // Same rule as the /chat route: this round's approved tools have already
      // run above, so the stash is only worth keeping if the continuation
      // parked on ANOTHER tool that still needs the bytes.
      if (!outcome.needsImages) {
        clearTurnImages(conversation_id);
      }
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
