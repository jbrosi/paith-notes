import type Anthropic from '@anthropic-ai/sdk';

/**
 * Server-side context-window breakdown.
 *
 * The Anthropic/LiteLLM `input_tokens` number already includes system + tools
 * + every message + every tool_result — so it's authoritative. But it's a
 * single opaque number. When the window "fills heavily" there's no way to
 * see *where* it's coming from. This module uses LiteLLM's
 * `/v1/messages/count_tokens` endpoint (which speaks the backend's own
 * tokenizer — important on Ollama, where the count differs from Anthropic's)
 * to attribute the total to its components:
 *
 *   base    = count(system)
 *   tools   = count(system + tools) - base
 *   per-msg = count(system + tools + messages[0..i]) - count(system + tools + messages[0..i-1])
 *   total   = count(system + tools + all messages)
 *
 * The per-message deltas approximate each message's marginal cost; the sum of
 * (base + tools + per-msg) ≈ total (small drift is normal because tokenizers
 * aren't additive — boundaries and control tokens vary).
 *
 * Gated on CHAT_DEBUG_CONTEXT=1 so the extra count_tokens calls (one per
 * prefix length) don't add load on a production deployment.
 */

export interface ContextBreakdown {
  model: string;
  systemTokens: number;
  toolsTokens: number;
  totalTokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    blocks: string[];
    marginalTokens: number;
  }>;
  biggest: Array<{ kind: string; label: string; tokens: number }>;
}

interface CountTokensBody {
  model: string;
  max_tokens?: number;
  system?: string;
  tools?: Anthropic.Tool[];
  messages?: Anthropic.MessageParam[];
}

async function countTokens(
  baseUrl: string,
  apiKey: string,
  body: CountTokensBody,
): Promise<number> {
  const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`count_tokens ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = (await res.json()) as { input_tokens?: number };
  return j.input_tokens ?? 0;
}

function describeBlock(b: unknown): string {
  if (typeof b === 'string') return `text(${b.length}c)`;
  if (b && typeof b === 'object' && 'type' in b) {
    const t = b as Record<string, unknown>;
    switch (t.type) {
      case 'text': {
        const s = typeof t.text === 'string' ? t.text : '';
        return `text(${s.length}c)`;
      }
      case 'tool_use':
        return `tool_use:${String(t.name)}`;
      case 'tool_result': {
        const content = t.content;
        const len =
          typeof content === 'string'
            ? content.length
            : Array.isArray(content)
              ? JSON.stringify(content).length
              : 0;
        return `tool_result(${len}c)`;
      }
      case 'thinking':
        return `thinking`;
      default:
        return String(t.type);
    }
  }
  return 'unknown';
}

// LiteLLM/Ollama's count_tokens endpoint tokenizes the raw tool-schema JSON
// but the live inference path adds per-tool overhead (tool-calling framing,
// control tokens) the counter skips. Measured on the shared proxy across
// paith-low / paith-high / qwen3.8 (same backend): the gap is a fixed
// intercept PLUS a per-tool slope. Least-squares fit of (live - count)
// vs tool-count:  overhead(N) ≈ 194 + 56.6·N  (max error ~94 tokens).
// Messages and system prompt match to a flat +3, so only the tools line
// needs calibrating. Override via CHAT_CTX_TOOL_OVERHEAD_INTERCEPT /
// CHAT_CTX_TOOL_OVERHEAD_SLOPE if the backend changes.
function toolOverhead(n: number): number {
  const intercept = numEnv('CHAT_CTX_TOOL_OVERHEAD_INTERCEPT', 194);
  const slope = numEnv('CHAT_CTX_TOOL_OVERHEAD_SLOPE', 56.6);
  return Math.round(intercept + slope * n);
}
function numEnv(key: string, fallback: number): number {
  const v = Number((process.env[key] ?? '').trim());
  return Number.isFinite(v) ? v : fallback;
}

export async function computeContextBreakdown(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
): Promise<ContextBreakdown> {
  // count_tokens requires a non-empty messages array; use a single-token
  // probe when measuring the system / system+tools prefixes in isolation.
  const probe: Anthropic.MessageParam[] = [{ role: 'user', content: ' ' }];
  const base = await countTokens(baseUrl, apiKey, { model, system, messages: probe });
  const withTools = await countTokens(baseUrl, apiKey, { model, system, tools, messages: probe });
  // calibrate the tools figure up to match the live inference path (see
  // toolOverhead). Without this the tools line is ~24% low.
  const toolsTokens = Math.max(0, withTools - base) + toolOverhead(tools.length);

  const perMessage: Array<{ role: 'user' | 'assistant'; blocks: string[]; marginalTokens: number }> = [];
  // running starts from the *calibrated* base (system + tools-as-the-window-
  // sees-them) so the per-message marginals and the final total are consistent
  // with the live input_tokens, not the raw count_tokens.
  let running = base + toolsTokens;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const content = m.content;
    const blocks = Array.isArray(content)
      ? content.map(describeBlock)
      : [describeBlock(content)];
    const prefix = messages.slice(0, i + 1);
    // count_tokens of (system + tools + prefix). The message portion is
    // accurate (flat +3 vs live); the tools portion carries the same
    // uncalibrated gap, so add the per-tool overhead back to keep the
    // running total on the live path's scale.
    const next =
      (await countTokens(baseUrl, apiKey, {
        model,
        system,
        tools,
        messages: prefix,
      })) + toolOverhead(tools.length);
    perMessage.push({
      role: m.role,
      blocks,
      marginalTokens: Math.max(0, next - running),
    });
    running = next;
  }
  const totalTokens = running;

  // Collect candidate contributors so the operator can see what's eating the window.
  const candidates: Array<{ kind: string; label: string; tokens: number }> = [
    { kind: 'system', label: 'system prompt', tokens: base },
    { kind: 'tools', label: `${tools.length} tool schemas`, tokens: toolsTokens },
  ];
  perMessage.forEach((m, i) => {
    for (const b of m.blocks) {
      // For tool_result blocks the "label" is the size hint we already emitted.
      candidates.push({
        kind: m.role,
        label: `msg#${i + 1} ${b}`,
        tokens: m.marginalTokens,
      });
    }
  });
  const biggest = candidates
    .filter(c => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  return {
    model,
    systemTokens: base,
    toolsTokens,
    totalTokens,
    messages: perMessage,
    biggest,
  };
}

export function formatBreakdown(b: ContextBreakdown): string {
  const lines: string[] = [];
  lines.push(
    `[ctx] model=${b.model}  system=${b.systemTokens}  tools=${b.toolsTokens}  total=${b.totalTokens}`,
  );
  lines.push(
    `[ctx] messages=${b.messages.length}  (sum of marginals=${b.messages.reduce((a, m) => a + m.marginalTokens, 0)})`,
  );
  lines.push('[ctx] top contributors:');
  for (const c of b.biggest) {
    lines.push(`  ${String(c.tokens).padStart(6)}  ${c.label}`);
  }
  return lines.join('\n');
}

export function isDebugContextEnabled(): boolean {
  const v = (process.env.CHAT_DEBUG_CONTEXT ?? '').trim();
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}
