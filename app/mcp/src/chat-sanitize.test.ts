import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { sanitizeOrphanedToolUses } from './chat.js';

// Compact helpers for building Anthropic message-param fixtures.
const text = (t: string): Anthropic.TextBlockParam => ({ type: 'text', text: t });
const toolUse = (id: string, name = 'mock_tool'): Anthropic.ToolUseBlockParam => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});
const toolResult = (id: string, content = 'ok'): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const userMsg = (content: Anthropic.MessageParam['content']): Anthropic.MessageParam => ({ role: 'user', content });
const asstMsg = (content: Anthropic.MessageParam['content']): Anthropic.MessageParam => ({ role: 'assistant', content });

describe('sanitizeOrphanedToolUses', () => {
  it('is a no-op when every tool_use already has a matching tool_result', () => {
    const input: Anthropic.MessageParam[] = [
      userMsg([text('hi')]),
      asstMsg([toolUse('A'), toolUse('B')]),
      userMsg([toolResult('A'), toolResult('B')]),
      asstMsg([text('done')]),
    ];
    const out = sanitizeOrphanedToolUses(input);
    assert.deepEqual(out, input);
  });

  it('injects synthetic tool_results for orphans, merging into the next user message', () => {
    // Classic disconnect scenario: assistant called two tools, network died
    // before the result POST landed, user now types a fresh message.
    const input: Anthropic.MessageParam[] = [
      userMsg([text('do the thing')]),
      asstMsg([toolUse('A'), toolUse('B')]),
      userMsg([text('hello again')]),
    ];
    const out = sanitizeOrphanedToolUses(input);

    assert.equal(out.length, 3);
    const lastUser = out[2];
    assert.equal(lastUser.role, 'user');
    assert.ok(Array.isArray(lastUser.content));
    const blocks = lastUser.content as Anthropic.ContentBlockParam[];
    // Synthetic tool_results come FIRST so the immediately-following
    // user turn carries the pair the API requires.
    assert.equal(blocks[0].type, 'tool_result');
    assert.equal((blocks[0] as Anthropic.ToolResultBlockParam).tool_use_id, 'A');
    assert.equal((blocks[0] as Anthropic.ToolResultBlockParam).is_error, true);
    assert.equal(blocks[1].type, 'tool_result');
    assert.equal((blocks[1] as Anthropic.ToolResultBlockParam).tool_use_id, 'B');
    assert.equal(blocks[2].type, 'text');
    assert.equal((blocks[2] as Anthropic.TextBlockParam).text, 'hello again');
  });

  it('only fills the missing ids when some tool_results are present', () => {
    const input: Anthropic.MessageParam[] = [
      asstMsg([toolUse('A'), toolUse('B'), toolUse('C')]),
      userMsg([toolResult('A'), text('partial follow-up')]),
    ];
    const out = sanitizeOrphanedToolUses(input);
    const merged = out[1];
    assert.ok(Array.isArray(merged.content));
    const blocks = merged.content as Anthropic.ContentBlockParam[];
    // B and C synthesised in front; A and the text preserved after.
    assert.deepEqual(
      blocks.map(b => b.type),
      ['tool_result', 'tool_result', 'tool_result', 'text'],
    );
    const ids = (blocks.filter(b => b.type === 'tool_result') as Anthropic.ToolResultBlockParam[]).map(b => b.tool_use_id);
    assert.deepEqual(ids, ['B', 'C', 'A']);
  });

  it('inserts a standalone user message when the orphan is the very last message', () => {
    const input: Anthropic.MessageParam[] = [
      userMsg([text('go')]),
      asstMsg([toolUse('A')]),
    ];
    const out = sanitizeOrphanedToolUses(input);
    assert.equal(out.length, 3);
    assert.equal(out[2].role, 'user');
    const blocks = out[2].content as Anthropic.ContentBlockParam[];
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'tool_result');
    assert.equal((blocks[0] as Anthropic.ToolResultBlockParam).tool_use_id, 'A');
  });

  it('normalises a string-content user message into blocks when merging', () => {
    const input: Anthropic.MessageParam[] = [
      asstMsg([toolUse('A')]),
      { role: 'user', content: 'plain string' },
    ];
    const out = sanitizeOrphanedToolUses(input);
    const merged = out[1];
    assert.ok(Array.isArray(merged.content));
    const blocks = merged.content as Anthropic.ContentBlockParam[];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'tool_result');
    assert.equal((blocks[1] as Anthropic.TextBlockParam).text, 'plain string');
  });

  it('is idempotent — re-sanitising already-sanitised history leaves it unchanged', () => {
    const input: Anthropic.MessageParam[] = [
      asstMsg([toolUse('A')]),
      userMsg([text('hello again')]),
    ];
    const once = sanitizeOrphanedToolUses(input);
    const twice = sanitizeOrphanedToolUses(once);
    assert.deepEqual(twice, once);
  });
});
