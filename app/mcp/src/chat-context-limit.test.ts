import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextLimitFor, parseContextLimit } from './chat.js';

describe('contextLimitFor', () => {
  it('uses the per-model table when no overrides are set', () => {
    assert.equal(contextLimitFor('claude-sonnet-5', {}), 1_000_000);
    assert.equal(contextLimitFor('claude-haiku-4-5-20251001', {}), 200_000);
    // Both local models are Qwen-family with 256K native context.
    assert.equal(contextLimitFor('paith-low', {}), 262_144);
    assert.equal(contextLimitFor('paith-high', {}), 262_144);
  });

  it('falls back to 200K for unknown models with no override', () => {
    assert.equal(contextLimitFor('some-local-model', {}), 200_000);
  });

  it('applies a per-model override (CHAT_CTX_<NAME>) for that model only', () => {
    // paith-low -> CHAT_CTX_PAITH_LOW
    assert.equal(
      contextLimitFor('paith-low', { CHAT_CTX_PAITH_LOW: '131072' }),
      131_072,
    );
    // paith-high is untouched by paith-low's override.
    assert.equal(
      contextLimitFor('paith-high', { CHAT_CTX_PAITH_LOW: '131072' }),
      262_144,
    );
  });

  it('maps dotted/colon model names to a valid env key', () => {
    // qwen3.8:27b-mtp-q4_K_M -> CHAT_CTX_QWEN3_8_27B_MTP_Q4_K_M
    assert.equal(
      contextLimitFor('qwen3.8:27b-mtp-q4_K_M', {
        CHAT_CTX_QWEN3_8_27B_MTP_Q4_K_M: '131072',
      }),
      131_072,
    );
  });

  it('uses global CHAT_CONTEXT_LIMIT as a last resort for unknown models', () => {
    assert.equal(
      contextLimitFor('some-local-model', { CHAT_CONTEXT_LIMIT: '40960' }),
      40_960,
    );
  });

  it('prefers the per-model override over the global one', () => {
    assert.equal(
      contextLimitFor('paith-low', {
        CHAT_CTX_PAITH_LOW: '131072',
        CHAT_CONTEXT_LIMIT: '40960',
      }),
      131_072,
    );
  });

  it('ignores invalid overrides', () => {
    for (const bad of ['0', '-5', '256k', '1.5', 'abc']) {
      assert.equal(parseContextLimit(bad), undefined, bad);
      assert.equal(
        contextLimitFor('claude-sonnet-5', { CHAT_CTX_CLAUDE_SONNET_5: bad }),
        1_000_000,
        bad,
      );
    }
  });
});
