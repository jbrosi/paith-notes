import { Router } from 'express';
import type express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { TOOLS, executeTool } from './chat-tools.js';
import { optionalAutoApprovedTools } from './tools/registry.js';
import { runSearchAgent, type SearchAgentContext } from './search-agent.js';
import { VoiceTagStripper, SentenceBuffer } from './voice-tag.js';

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

// Voice service for the integrated TTS pipeline. MCP forwards text deltas
// it produces into the streaming TTS endpoint and re-emits the resulting
// audio chunks on the same SSE the frontend already listens to.
// VOICE_BASE_URL points at the voice container (Kokoro TTS). STT is *not*
// routed through here — the frontend hits /api/voice/stt directly via
// Caddy, which always proxies to the local container so the user's mic
// audio never leaves the home network even when TTS runs in the cloud.
const VOICE_BASE_URL = process.env.VOICE_BASE_URL ?? 'http://voice:8000';
// Shared bearer secret matching the voice service's VOICE_TOKEN. Empty
// disables auth (fine for the local compose default; required when the
// URL is public).
const VOICE_TOKEN = (process.env.VOICE_TOKEN ?? '').trim();

// VOICE_PROVIDER=openai routes all TTS to OpenAI's /v1/audio/speech instead
// of the local Kokoro container, and unlocks per-sentence delivery
// instructions via the `<voice instr>` model output convention. STT still
// goes to the local voice container regardless. Defaults to `local`.
const VOICE_PROVIDER = (process.env.VOICE_PROVIDER ?? 'local').trim().toLowerCase();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? '').trim();
// gpt-4o-mini-tts is the cheapest tier ($0.05/1M chars equiv) and is the
// only model that honours the `instructions` field.
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts').trim();
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE ?? 'nova').trim();

// Sentence-end detection — fires when `.!?` (optionally followed by a
// closing quote/bracket) is followed by whitespace, or on a newline.
// Same regex shape as the previous frontend splitter but centralized here.
const SENTENCE_END = /([.!?]+["')\]]*\s+|\n+)/;

// Strip markdown-y bits that sound bad read aloud (code fences, link
// targets, leading heading markers, UUID-shaped tokens like note IDs).
// Mirrors the old frontend cleanup plus voice-specific scrubbing.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NOTE_REF_RE = /\[\[note:[^\]]+\]\]/g;
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // [[note:UUID]] is a UI-only marker — the user sees a clickable title;
    // for TTS we drop it entirely (no graceful spoken equivalent).
    .replace(NOTE_REF_RE, '')
    // Bare UUIDs (tool inputs, IDs the model wrote into prose) — TTS
    // would otherwise enunciate every digit and burn synth time.
    .replace(UUID_RE, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .trim();
}

/**
 * Streams sentences to the voice service eagerly (fires fetch the moment a
 * sentence boundary closes) while emitting the resulting audio chunks to
 * the client in strict submission order.
 *
 * "Eager fetch + ordered drain" is the trick: by the time we get to
 * sentence N's drain, the voice service has often already produced its
 * chunks because N's fetch went out while N-1 was still being read. On a
 * laptop that can run two or three concurrent Kokoro syntheses, this
 * accumulates a buffer and the client never starves between sentences.
 */
class VoiceStreamer {
  private pending: Promise<void> = Promise.resolve();
  private res: express.Response;
  private lang: string;
  private seq = 0;
  // Snapshot env once at construction so a hot-reload (or test override)
  // is the only way to flip provider mid-process.
  private provider: 'local' | 'openai' =
    VOICE_PROVIDER === 'openai' && OPENAI_API_KEY ? 'openai' : 'local';

  constructor(res: express.Response, lang: string) {
    this.res = res;
    this.lang = lang;
    if (VOICE_PROVIDER === 'openai' && !OPENAI_API_KEY) {
      console.warn(
        '[voice] VOICE_PROVIDER=openai but OPENAI_API_KEY is unset — falling back to local voice service.',
      );
    }
  }

  enqueueSentence(rawSentence: string, instructions?: string | null): void {
    const clean = stripForSpeech(rawSentence);
    if (!clean) return;
    const seq = ++this.seq;
    console.log(
      `[voice] #${seq} enqueue provider=${this.provider} lang=${this.lang} chars=${clean.length}` +
        (instructions ? ` instr=${JSON.stringify(instructions.slice(0, 60))}` : '') +
        ` text=${JSON.stringify(clean.slice(0, 60))}`,
    );
    const doFetch = () => {
      if (this.provider === 'openai') {
        return fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OPENAI_TTS_MODEL,
            input: clean,
            voice: OPENAI_TTS_VOICE,
            // OpenAI returns the full audio per request; `mp3` is the
            // browser-friendliest format that AudioContext.decodeAudioData
            // accepts everywhere.
            response_format: 'mp3',
            // Only `gpt-4o-mini-tts` honours `instructions`; older tiers
            // silently ignore it, so we always pass it when present.
            ...(instructions ? { instructions } : {}),
          }),
        });
      }
      return fetch(`${VOICE_BASE_URL}/tts/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(VOICE_TOKEN ? { Authorization: `Bearer ${VOICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          text: clean,
          lang: this.lang,
        }),
      });
    };
    // Eager fetch: the next request goes out while we're still draining
    // the current one. Kokoro is fast and lockless, so the pipeline stays
    // saturated and the client never starves between sentences.
    const fetchPromise = doFetch();
    // Optional client-side debug: emit a structured event the frontend can
    // surface in a debug panel without parsing log lines.
    sse(this.res, 'voice_debug', {
      seq,
      kind: 'sentence_enqueued',
      chars: clean.length,
      text: clean.slice(0, 80),
    });
    // Chain the drain after any previously queued drains so chunks reach
    // the SSE in the order their source sentences came in.
    this.pending = this.pending.then(async () => {
      const fetchStartedAt = Date.now();
      try {
        const r = await fetchPromise;
        const synthFirstByteMs = Date.now() - fetchStartedAt;
        if (!r.ok || !r.body) {
          // Read body for diagnostics — TTS providers return JSON error
          // details (e.g. "Incorrect API key", "model not accessible by
          // this project") that the raw status code hides.
          const errBody = await r.text().catch(() => '<unreadable>');
          console.error(
            `[voice] #${seq} tts failed status=${r.status} body=${errBody.slice(0, 500)}`,
          );
          sse(this.res, 'voice_debug', {
            seq,
            kind: 'error',
            status: r.status,
            body: errBody.slice(0, 500),
          });
          return;
        }
        let chunkIdx = 0;
        let totalBytes = 0;

        if (this.provider === 'openai') {
          // OpenAI returns a single encoded audio body per request — no
          // framing. AudioContext.decodeAudioData needs the whole MP3 to
          // decode anyway, so we buffer and emit it as one chunk.
          const ab = await r.arrayBuffer();
          const all = new Uint8Array(ab);
          chunkIdx = 1;
          totalBytes = all.length;
          sse(this.res, 'audio_chunk', {
            seq,
            chunk: chunkIdx,
            data: Buffer.from(all).toString('base64'),
          });
        } else {
          const reader = r.body.getReader();
          let buf = new Uint8Array(0);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              // Reader's Uint8Array may be backed by SharedArrayBuffer; copy
              // into a fresh ArrayBuffer-backed buffer for type compatibility
              // and so subsequent subarray() slices outlive the reader.
              const copy = new Uint8Array(value.length);
              copy.set(value);
              buf = concatU8(buf, copy);
            }
            while (buf.length >= 4) {
              const length =
                (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
              if (buf.length < 4 + length) break;
              const chunk = buf.subarray(4, 4 + length);
              chunkIdx++;
              totalBytes += chunk.length;
              sse(this.res, 'audio_chunk', {
                seq,
                chunk: chunkIdx,
                data: Buffer.from(chunk).toString('base64'),
              });
              buf = buf.subarray(4 + length);
            }
          }
        }
        const totalMs = Date.now() - fetchStartedAt;
        console.log(
          `[voice] #${seq} done chunks=${chunkIdx} bytes=${totalBytes} ttfb=${synthFirstByteMs}ms total=${totalMs}ms`,
        );
        sse(this.res, 'voice_debug', {
          seq,
          kind: 'sentence_done',
          chunks: chunkIdx,
          bytes: totalBytes,
          ttfb_ms: synthFirstByteMs,
          total_ms: totalMs,
        });
      } catch (e) {
        console.error(`[voice] #${seq} drain error`, e);
        sse(this.res, 'voice_debug', {
          seq,
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

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

// Tools that are always safe to auto-execute (read-only / non-destructive).
// Core list lives here; optional tool modules contribute their own
// auto-approved names via the registry (e.g. weather + wikipedia).
const ALWAYS_AUTO_TOOLS = new Set([
  'list_note_types',
  'list_type_attributes',
  'list_link_predicates',
  'get_note_mentions',
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

// ─── Handbook nook ────────────────────────────────────────────────────────────

async function resolveHandbookNookId(cookie: string, apiBase: string): Promise<string | null> {
  try {
    const data = await phpApi('GET', '/api/nooks/handbook', cookie, apiBase) as { nook?: { id?: string } };
    return data?.nook?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchHandbookNotes(handbookNookId: string, cookie: string, apiBase: string): Promise<InstructionNote[]> {
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
): string {
  const ts = new Date().toISOString().slice(0, 16) + 'Z';
  let meta = `[${ts}]`;
  // Per-message speaker attribution — in a living-room kiosk multiple
  // family members can take turns within the same conversation, so
  // attaching the speaker to the conversation (system prompt) misleads
  // the model. We embed the name in the message text itself, in the
  // same bracket-tag pattern as the timestamp; the frontend renders
  // chat messages cleaned of these brackets so the human view stays
  // readable.
  if (speakerName) {
    meta += ` [spoken by ${speakerName}]`;
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

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  nookId: string,
  nookName: string,
  nookRole: string,
  memoryNookId?: string | null,
  nookInstructions?: InstructionNote[],
  memoryNotes?: InstructionNote[],
  handbookNookId?: string | null,
  handbookNotes?: InstructionNote[],
  voiceMode?: boolean,
): string {
  const nookDisplay = nookName ? `"${nookName}" (${nookId})` : `"${nookId}"`;
  const roleInfo = nookRole ? ` The user's role in this nook is "${nookRole}".` : '';
  const parts = [
    `You are an assistant integrated into paith notes. You are operating in nook ${nookDisplay}.${roleInfo}

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

Page links — when you want to link users to specific app pages (not note content), use standard markdown links with these URL patterns:
- Nook dashboard: [Nook Name](/nooks/{nookId})
- Note: [Note Title](/nooks/{nookId}/notes/{noteId})
- Note at version: [v3](/nooks/{nookId}/notes/{noteId}/v/{version})
- Version diff: [compare v2→v5](/nooks/{nookId}/notes/{noteId}/compare/{fromVersion}/{toVersion})
- Diff with current: [compare v2→current](/nooks/{nookId}/notes/{noteId}/compare/{fromVersion})
- Note history: [history](/nooks/{nookId}/notes/{noteId}/history)
Use [[note:...]] for referencing notes by name, but use page links when directing users to specific views like diffs, versions, or dashboards.

General rules:
- You have access to the user's notes via tools — never ask for a nook ID or note ID, use the IDs from tool results directly.
- Only use tools when the user explicitly asks. Always tell the user what you are about to do before calling a tool.
- When you need to make multiple independent tool calls, issue them all in a single response as parallel tool_use blocks rather than sequentially.

Speaker attribution: user messages may include a \`[spoken by <name>]\` metadata tag in the leading bracket-prefix (alongside the timestamp). This means voice identified an enrolled household member by their voiceprint. Treat each message's speaker independently — multiple people can share a single conversation, so do NOT assume the speaker stays constant across messages. When a name is present, address that person by name where natural and use it to disambiguate "I/me/my" references. When no \`[spoken by]\` tag is present, the speaker is unknown (typed text, an unenrolled guest, or a clip that didn't match any voiceprint) — treat them as anonymous and don't ask for their identity unless directly relevant.

**search_notes behavior:** The q parameter is optional — omit it or pass an empty string to list all notes (optionally filtered by type_id). Do NOT search for common words like "a" or "the" to find all notes. Multiple words are automatically split: by default all must match (AND). Use search_mode="or" if you want any word to match. The same applies to explore_notes q parameter.

**search_agent:** When you need to research a topic across multiple notes, use the search_agent tool instead of searching manually. The search agent runs in its own context window, can search and read notes across all accessible nooks, and returns ranked results with relevant excerpts — keeping this conversation's context clean. The user must approve before it runs. Always tell the user what you're about to search for before calling it. Use it for:
- Broad research questions ("find everything about X")
- Questions that may require reading multiple notes to synthesize an answer
- When context usage is high and you need to search
For simple, targeted lookups (one search + one note read), use search_notes/get_note directly — the search agent adds overhead for trivial queries.

**Tool approval:** The following tools auto-execute without user approval: get_note_mentions, list_note_types, list_type_attributes, list_link_predicates, and all memory_* tools (memory_search, memory_get, memory_create, memory_update). All other tools (get_note, create_note, update_note, delete_note, create_note_link, open_note, create_note_type, update_note_type, search_agent) require user confirmation.

**Mermaid diagrams:** Both note content and your chat responses support mermaid diagrams via fenced code blocks (\`\`\`mermaid). Use them when visualizing relationships, flows, timelines, or architectures would help the user. The UI renders them as interactive SVGs.`,
    memoryNookId
      ? `**AI Memory:** You have a personal memory nook for this user (ID: ${memoryNookId}). Use the memory_* tools (memory_search, memory_get, memory_create, memory_update) to store and retrieve knowledge about the user — preferences, facts, communication style, corrections, project context. These are auto-approved and persist across all nooks and conversations.

At the start of each conversation, proactively search user memory with memory_search() to recall relevant context. When the user shares preferences or corrects you, store it in user memory immediately.

**Memory retrieval protocol:** Before answering any question about past context or preferences: (1) call memory_search(q="<topic>") to find relevant memories, (2) call memory_get on matches to read full content. Only after checking memory should you search the current nook's notes.

When you create or update a memory note, the system automatically links it to the current conversation — this builds a knowledge trail showing why each memory exists and which conversations contributed to it.`
      : '',
    `**Note type taxonomy:** You can help the user manage their note taxonomy. Use list_note_types to see the full hierarchy before suggesting or creating types. When creating a type, always tell the user where in the hierarchy it will appear (e.g. "Creating 'Employee' as a subtype of 'Person'"). You can update a type's label or description with update_note_type. Never create a type without showing the user what you're about to create and where it fits.

**IMPORTANT — Always assign a type when creating notes:** Every note MUST have a type_id. Before creating a note, call list_note_types (auto-approved) to see available types and pick the best fit. If a matching type exists (e.g. "meeting", "person", "recipe"), use it. If nothing specific fits, use the base type (key: "base" — you can pass the key string "base" as type_id). Never create a note without type_id.`,
    `**Type attributes:** Each type can have structured attributes (text, number, boolean, date, date_range, select, file, graph, view, multi_select, url, linked_notes, mentions, history, toc, metadata, content). Use list_type_attributes to see what a type supports — this returns attribute IDs, names, kinds, config, and inheritance info. When creating or updating notes, pass attribute values in the "attributes" field as { "<attribute_uuid>": value }. Example workflow:
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
- multi_select: array of strings matching configured options
- url: string URL
- file: managed by the file upload system (don't set directly)
- graph: { rootNoteId: "<uuid>", depth?: 2, layout?: "force"|"tree"|"radial", ... }
- linked_notes, mentions, history, toc, metadata, content: presentational — rendered by the UI based on type config, no note-level value needed

**Attribute inheritance:** Attributes are inherited from parent types down the type hierarchy. When you call list_type_attributes, each attribute includes:
- "inherited": true/false — whether it comes from an ancestor type
- "overridden": true/false — whether this type has customized the inherited attribute's config
Sub-types can override inherited attribute config (e.g. change display settings), hide inherited attributes entirely, or reorder them. Hidden attributes won't appear in list_type_attributes results — so only write to attributes that are listed. Only write values for data-bearing kinds (text, number, boolean, date, date_range, select, multi_select, url, graph). Presentational kinds (linked_notes, mentions, history, toc, metadata, content) are rendered automatically by the UI.`,
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

  if (handbookNookId && handbookNotes && handbookNotes.length > 0) {
    const list = handbookNotes.map(n => `- "${n.title}" (ID: ${n.id})`).join('\n');
    parts.push(
      `**Application Handbook** (nook ID: ${handbookNookId}): A read-only handbook is available with documentation about this application. Reading these notes via get_note is FREE (auto-approved, pass nook_id="${handbookNookId}"). Consult these when the user asks about how the application works, features, or capabilities:\n${list}\n\nUse the cross-nook link format [[note:${handbookNookId}/<noteId>]] when referencing handbook notes in your responses.`,
    );
  }

  parts.push(
    `**User message metadata:** Each user message starts with a timestamp in brackets, and when the viewed note changes, a [Note: "title" (id, type: kind)] tag. When the user says "this note", "the current note", "my note", "here", or similar, they mean the note from the most recent [Note: ...] tag in the conversation. Use its ID directly without asking.\n\nTo read the current note, use get_note (user confirms). When asked about context: (1) call explore_notes(note_id="<id from latest Note tag>", direction="both") — free, (2) call get_note_mentions — free, (3) memory_search. Issue independent calls in parallel.`,
  );

  if (voiceMode) {
    parts.push(
      `**Voice mode is active.** Your reply will be spoken aloud, sentence by sentence.

- Respond conversationally in 1–3 short sentences. No markdown, no code blocks, no bullet lists, no headings — none of that survives synthesis.
- Reply in the same language the user wrote in. The TTS engine is multilingual; mixing English and German in one response is fine if the user does.
- If you need to show structured content, do the work via tools and give a brief spoken summary.
- When announcing a tool call, say one short conversational sentence about what you're doing (e.g. "Let me look that up" or "Saving that to memory now") — never read out tool names, UUIDs, IDs, JSON, or parameter values; the UI shows those visually.

You may shape how individual sentences are spoken by **prefixing them** with a double-bracket marker:

  [[voice: warm, slow, smiling]] Welcome back.
  Most sentences should have no marker — flowing prose sounds best.
  [[voice: conspiratorial whisper]] Here's the secret.

The bracketed value is a free-form delivery hint (tone, pace, emotion, accent, persona). Use it sparingly — tagging every sentence sounds artificial. Reserve it for genuine emphasis, character voices, or tone shifts.

**Strict rules — read these:**
- The marker MUST start with \`[[voice:\` (note the \`voice:\` prefix — without it, the bracket is treated as a regular note link like \`[[note:…]]\` and the inflection is ignored).
- A marker applies to **exactly one sentence — the one it prefixes**. There is no "carryover" semantic. If you want three consecutive sentences to share the same delivery, prefix each one: \`[[voice: excited]] One! [[voice: excited]] Two! [[voice: excited]] Three!\`. Markers don't accumulate or persist.
- The marker is stripped from the visible transcript, so the user sees clean text and hears the inflected audio.

Do NOT use other formats — no XML tags, no \`<voice>\`, no \`<parameter>\`. Only \`[[voice: …]]\` is parsed.`,
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
  voice?: { lang: string } | null,
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

  // mutable copy we extend on each auto-execute loop
  const msgs: Anthropic.MessageParam[] = [...messages];
  let lastInputTokens = 0;

  try {
    for (let depth = 0; depth <= MAX_AUTO_DEPTH; depth++) {
      // Build system blocks — base prompt is cached, pressure hint is a separate uncached block
      const systemBlocks: Anthropic.TextBlockParam[] = [
        { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },
      ];
      if (lastInputTokens > 0) {
        const ratio = lastInputTokens / contextLimit;
        let pressureHint = '';
        if (ratio > CONTEXT_CRITICAL_THRESHOLD) {
          pressureHint = '**CRITICAL — Context window is ' + Math.round(ratio * 100) + '% full.** You MUST:\n1. Keep responses very concise\n2. Strongly encourage the user to start a new chat\n3. Offer to summarize key outcomes/decisions into a memory note before they do\n4. After saving to memory, tell the user to click "New chat" to continue fresh';
        } else if (ratio > CONTEXT_WARNING_THRESHOLD) {
          pressureHint = '**Context window is ' + Math.round(ratio * 100) + '% full.** Suggest starting a new chat soon. Offer to summarize outcomes to memory first. Keep responses concise.';
        } else if (ratio > CONTEXT_SOFT_THRESHOLD) {
          pressureHint = '**Context note:** Window is ' + Math.round(ratio * 100) + '% full. If the user switches topics or you sense a natural break, gently suggest starting a new chat. No need to force it.';
        }
        if (pressureHint) systemBlocks.push({ type: 'text', text: pressureHint });
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
              trailing.push({
                event: 'awaiting_approval',
                data: {
                  conversation_id: conversationId,
                  tools: toolsPayload,
                  display_names: displayNames,
                  nook_name: nookName,
                  nook_id: nookId,
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
    const { message, model, conversation_id, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang, speaker_name } = req.body as Record<string, unknown>;
    const speakerName =
      typeof speaker_name === 'string' && speaker_name.trim() !== ''
        ? speaker_name.trim()
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
      const messageText = buildMessageText(message as string, contextNote, prevContextNoteId, speakerName);
      const userMessage: Anthropic.MessageParam = {
        role: 'user',
        content: [{ type: 'text', text: messageText }],
      };
      await saveMessages(convId, [{ role: 'user', content: userMessage.content }], cookieHeader, apiBase);
      history.push(userMessage);

      sseHeaders(res);
      sse(res, 'conversation', { conversation_id: convId });

      await streamConversation(res, history, resolvedModel, convId, cookieHeader, apiBase, nook_id, contextNote, memoryNookId, voice);
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
    const { conversation_id, model, tool_results, context_note_id, context_note_title, context_note_type, voice_mode, voice_lang } = req.body as {
      conversation_id: string;
      model?: string;
      tool_results: ToolResult[];
      context_note_id?: string;
      context_note_title?: string;
      context_note_type?: string;
      voice_mode?: boolean;
      voice_lang?: string;
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
