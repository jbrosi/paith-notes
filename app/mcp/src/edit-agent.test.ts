import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { buildInheritMessages } from './edit-agent.js';

describe('edit-agent buildInheritMessages', () => {
  it('ends on a single user turn (valid alternation, ready to send to API)', () => {
    const main: Anthropic.MessageParam[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const out = buildInheritMessages(main, 'do thing');
    // u1, a1, [synthetic user] — u2 gets folded INTO the synthetic user task block.
    assert.equal(out.length, 3);
    assert.equal(out[2].role, 'user');
    assert.match(String(out[2].content), /do thing/);
    assert.match(String(out[2].content), /u2/);
  });

  it("includes the prefix up to and including the last assistant turn", () => {
    const main: Anthropic.MessageParam[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    const out = buildInheritMessages(main, 'task');
    // Prefix should be u1, a1, u2, a2 (everything up to + including the
    // last assistant turn) + the synthetic user with the task. u3 folds
    // into the task block.
    assert.equal(out.length, 5);
    assert.equal(out[0].role, 'user');
    assert.equal(out[3].role, 'assistant');
    assert.equal(out[3].content, 'a2');
    assert.equal(out[4].role, 'user');
    assert.match(String(out[4].content), /u3/);
  });

  it("works when main ends on an assistant turn (no trailing user text to fold in)", () => {
    const main: Anthropic.MessageParam[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const out = buildInheritMessages(main, 'task');
    assert.equal(out.length, 3);
    assert.equal(out[2].role, 'user');
    const content = String(out[2].content);
    assert.match(content, /task/);
    // No "User's most recent message(s)" section when there's no trailing text.
    assert.doesNotMatch(content, /User's most recent message/);
  });

  it("handles main with no assistant turn yet (e.g. first message of conversation)", () => {
    const main: Anthropic.MessageParam[] = [{ role: 'user', content: 'u1' }];
    const out = buildInheritMessages(main, 'task');
    // No prefix; just the synthetic user turn with u1 folded in.
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'user');
    assert.match(String(out[0].content), /task/);
    assert.match(String(out[0].content), /u1/);
  });

  it("extracts text blocks from array-content user messages when folding", () => {
    const main: Anthropic.MessageParam[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello from blocks' },
        ],
      },
    ];
    const out = buildInheritMessages(main, 'task');
    assert.match(String(out[2].content), /hello from blocks/);
  });

  it("preserves prefix message identity (cache-friendly: same objects reused)", () => {
    const main: Anthropic.MessageParam[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const out = buildInheritMessages(main, 'task');
    // First two messages in `out` should be the SAME object references
    // as in `main` — content equality is what the prompt cache keys on,
    // and reusing references avoids accidental drift.
    assert.strictEqual(out[0], main[0]);
    assert.strictEqual(out[1], main[1]);
  });
});
