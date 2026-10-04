import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { stripStaleImageBlocks, DROPPED_IMAGE_NOTICE } from './image-budget.js';

// A look_at_image tool_result as /chat stores it: a text header plus the real
// pixel block.
function lookResult(data: string): Anthropic.ToolResultBlockParam {
	return {
		type: 'tool_result',
		tool_use_id: 'tu-' + data.length + '-' + data.slice(-2),
		content: [
			{ type: 'text', text: 'You are now looking at chat attachment a-' + data.slice(-2) },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
		],
	};
}

function userTurn(blocks: unknown[]): Anthropic.MessageParam {
	return { role: 'user', content: blocks as Anthropic.ContentBlockParam[] };
}

function countImages(messages: Anthropic.MessageParam[]): number {
	let n = 0;
	for (const m of messages) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (typeof b !== 'object' || b === null) continue;
			const t = b as { type?: string; content?: unknown };
			if (t.type !== 'tool_result' || !Array.isArray(t.content)) continue;
			for (const inner of t.content) {
				if (typeof inner === 'object' && inner !== null && (inner as { type?: string }).type === 'image') n++;
			}
		}
	}
	return n;
}

describe('stripStaleImageBlocks', () => {
	it('keeps a single look_at_image result untouched', () => {
		const input = [userTurn([lookResult('AAAA')])];
		const out = stripStaleImageBlocks(input);
		assert.equal(countImages(out), 1);
		assert.equal(out[0].content[0], input[0].content[0], 'must not clone a message it has nothing to do');
	});

	it('leaves a history with no tool_result images completely alone', () => {
		const input: Anthropic.MessageParam[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
		];
		assert.deepEqual(stripStaleImageBlocks(input), input);
	});

	it('keeps the newest pixels and stubs the rest, telling the model how to get them back', () => {
		const input = [
			userTurn([lookResult('AAA')]),
			userTurn([lookResult('BBB')]),
			userTurn([lookResult('CCC')]),
		];
		const out = stripStaleImageBlocks(input, { keep: 1 });

		assert.equal(countImages(out), 1);
		const newest = out[2].content as Anthropic.ToolResultBlockParam[];
		assert.ok((newest[0].content as Anthropic.TextBlockParam[]).length === 2);
		const oldest = out[0].content as Anthropic.ToolResultBlockParam[];
		const stub = oldest[0].content as Anthropic.TextBlockParam[];
		assert.equal(stub.length, 2, 'the header text must survive — only pixels are dropped');
		assert.equal(stub[1].type, 'text');
		assert.equal((stub[1] as Anthropic.TextBlockParam).text, DROPPED_IMAGE_NOTICE);
		assert.match(DROPPED_IMAGE_NOTICE, /look_at_image/, 'the stub must be actionable');
	});

	it('caps distinct images at the budget', () => {
		const input = [
			userTurn([lookResult('AAA')]),
			userTurn([lookResult('BBB')]),
			userTurn([lookResult('CCC')]),
			userTurn([lookResult('DDD')]),
			userTurn([lookResult('EEE')]),
		];
		assert.equal(countImages(stripStaleImageBlocks(input, { keep: 2 })), 2);
		assert.equal(countImages(stripStaleImageBlocks(input, { keep: 4 })), 4);
		assert.equal(countImages(stripStaleImageBlocks(input, { keep: 0 })), 0);
	});

	it('counts a re-look at the SAME image once — the old copy is redundant', () => {
		// The model describes image AAA in turn 1, then re-looks in turn 5. The
		// pixels are identical, so keeping both doubles the cost for nothing.
		const input = [
			userTurn([lookResult('AAA')]),
			userTurn([lookResult('BBB')]),
			userTurn([lookResult('AAA')]),
		];
		const out = stripStaleImageBlocks(input, { keep: 1 });

		assert.equal(countImages(out), 1);
		const kept = (out[2].content as Anthropic.ToolResultBlockParam[])[0].content as Anthropic.TextBlockParam[];
		assert.equal(kept[1].type, 'image', 'the NEWEST look survives');
	});

	it('never strips the pixels of the user\'s own pasted attachment', () => {
		// Those are in a user turn, not a tool_result. They are bounded by how
		// many times the user pasted, and the UI shows them — hiding one would
		// contradict what the user can see in the transcript.
		const pasted: Anthropic.ContentBlockParam[] = [
			{ type: 'text', text: 'what is this?' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PASTED' } },
		];
		const input: Anthropic.MessageParam[] = [
			{ role: 'user', content: pasted },
			userTurn([lookResult('AAA')]),
		];
		const out = stripStaleImageBlocks(input, { keep: 0 });
		const kept = out[0].content as Anthropic.ContentBlockParam[];
		assert.equal(kept[1].type, 'image');
	});

	it('preserves tool_use pairing and every other block shape', () => {
		const original = [lookResult('AAA'), lookResult('BBB')];
		const input: Anthropic.MessageParam[] = [
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'look_at_image', input: {} }] },
			userTurn([...original, { type: 'text', text: 'next question' }]),
		];
		const out = stripStaleImageBlocks(input, { keep: 1 });

		const turn = out[1].content as Anthropic.ToolResultBlockParam[];
		assert.equal(turn.length, 3, 'block count must not change — only image → text');
		assert.equal(turn[0].tool_use_id, original[0].tool_use_id);
		assert.equal(turn[1].tool_use_id, original[1].tool_use_id);
		assert.equal(turn[2].type, 'text');
	});

	it('is idempotent — running it twice changes nothing further', () => {
		const input = [userTurn([lookResult('AAA')]), userTurn([lookResult('BBB')]), userTurn([lookResult('CCC')])];
		const once = stripStaleImageBlocks(input, { keep: 1 });
		assert.deepEqual(stripStaleImageBlocks(once, { keep: 1 }), once);
	});

	it('does not mutate the caller\'s messages', () => {
		const input = [userTurn([lookResult('AAA')]), userTurn([lookResult('BBB')])];
		const before = JSON.stringify(input);
		stripStaleImageBlocks(input, { keep: 1 });
		assert.equal(JSON.stringify(input), before, 'the persisted transcript must stay intact');
	});
});