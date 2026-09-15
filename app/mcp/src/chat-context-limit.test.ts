import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextLimitFor, parseContextLimit } from './chat.js';

describe('contextLimitFor', () => {
  it('uses the per-model table when no override is set', () => {
    assert.equal(contextLimitFor('claude-sonnet-5', ''), 1_000_000);
    assert.equal(contextLimitFor('claude-haiku-4-5-20251001', ''), 200_000);
  });

  it('falls back to 200K for unknown models', () => {
    assert.equal(contextLimitFor('some-local-model', ''), 200_000);
  });

  it('applies a valid override to every model', () => {
    assert.equal(contextLimitFor('claude-sonnet-5', '262144'), 262_144);
    assert.equal(contextLimitFor('claude-haiku-4-5-20251001', ' 32768 '), 32_768);
  });

  it('ignores invalid overrides', () => {
    for (const bad of ['0', '-5', '256k', '1.5', 'abc']) {
      assert.equal(parseContextLimit(bad), undefined, bad);
      assert.equal(contextLimitFor('claude-sonnet-5', bad), 1_000_000, bad);
    }
  });
});
