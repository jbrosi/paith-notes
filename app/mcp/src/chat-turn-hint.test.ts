import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { appendTurnHint } from './chat.js';

const user = (content: Anthropic.MessageParam['content']): Anthropic.MessageParam => ({ role: 'user', content });
const asst = (content: Anthropic.MessageParam['content']): Anthropic.MessageParam => ({ role: 'assistant', content });
const HINT = '[SYSTEM CONTEXT] window 42% full';

describe('appendTurnHint', () => {
  it('appends the hint as a trailing text block on the last user message', () => {
    const msgs = [user([{ type: 'text', text: 'hi' }])];
    const out = appendTurnHint(msgs, HINT);
    const content = out[0].content as Anthropic.ContentBlockParam[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[1], { type: 'text', text: HINT });
    // original array/object is not mutated (outgoing copy only)
    assert.equal((msgs[0].content as unknown[]).length, 1);
  });

  it('normalises a string-content user message into blocks before appending', () => {
    const out = appendTurnHint([user('plain')], HINT);
    assert.deepEqual(out[0].content, [
      { type: 'text', text: 'plain' },
      { type: 'text', text: HINT },
    ]);
  });

  it('keeps the hint AFTER existing tool_result blocks (cache breakpoint stays on persisted content)', () => {
    const msgs = [user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])];
    const out = appendTurnHint(msgs, HINT);
    const content = out[0].content as Anthropic.ContentBlockParam[];
    assert.equal(content[0].type, 'tool_result');
    assert.equal(content[1].type, 'text');
  });

  it('is a no-op when the hint is empty', () => {
    const msgs = [user([{ type: 'text', text: 'hi' }])];
    assert.equal(appendTurnHint(msgs, ''), msgs);
  });

  it('is a no-op when the last message is not a user turn', () => {
    const msgs = [user([{ type: 'text', text: 'hi' }]), asst([{ type: 'text', text: 'yo' }])];
    assert.equal(appendTurnHint(msgs, HINT), msgs);
  });
});
