import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type ContextBreakdown,
	formatBreakdown,
	isDebugContextEnabled,
} from "./chat/context-debug.js";

// isDebugContextEnabled is the only pure, network-free surface worth unit
// testing — computeContextBreakdown makes live count_tokens calls, which are
// covered by the live benchmark script (see the CHAT_DEBUG_CONTEXT docs in
// context-debug.ts). The calibration constants (194 + 56.6·N) are pinned by
// the same benchmark; re-derive them if the backend tokenizer changes.
describe("isDebugContextEnabled", () => {
	const saved = process.env.CHAT_DEBUG_CONTEXT;
	beforeEach(() => {
		delete process.env.CHAT_DEBUG_CONTEXT;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.CHAT_DEBUG_CONTEXT;
		else process.env.CHAT_DEBUG_CONTEXT = saved;
	});

	it("is off by default", () => {
		assert.equal(isDebugContextEnabled(), false);
	});
	it('is on for "1"', () => {
		process.env.CHAT_DEBUG_CONTEXT = "1";
		assert.equal(isDebugContextEnabled(), true);
	});
	it("is on for truthy strings", () => {
		for (const v of ["true", "TRUE", "yes", "Yes"]) {
			process.env.CHAT_DEBUG_CONTEXT = v;
			assert.equal(isDebugContextEnabled(), true, v);
		}
	});
	it("is off for falsy / empty / garbage", () => {
		for (const v of ["0", "false", "", "  ", "no", "off"]) {
			process.env.CHAT_DEBUG_CONTEXT = v;
			assert.equal(isDebugContextEnabled(), false, v);
		}
	});
});

describe("formatBreakdown", () => {
	it("renders system/tools/total and the top contributors", () => {
		const b: ContextBreakdown = {
			model: "test-model",
			systemTokens: 4310,
			toolsTokens: 10702,
			totalTokens: 15012,
			messages: [
				{ role: "user", blocks: ["text(20c)"], marginalTokens: 20 },
				{
					role: "assistant",
					blocks: ["tool_use:search_notes"],
					marginalTokens: 30,
				},
				{ role: "user", blocks: ["tool_result(12000c)"], marginalTokens: 1500 },
			],
			biggest: [
				{ kind: "tools", label: "43 tool schemas", tokens: 10702 },
				{ kind: "system", label: "system prompt", tokens: 4310 },
				{ kind: "user", label: "msg#3 tool_result(12000c)", tokens: 1500 },
			],
		};
		const out = formatBreakdown(b);
		assert.match(out, /model=test-model/);
		assert.match(out, /system=4310/);
		assert.match(out, /tools=10702/);
		assert.match(out, /total=15012/);
		assert.match(out, /top contributors/);
		assert.match(out, /43 tool schemas/);
		assert.match(out, /msg#3 tool_result\(12000c\)/);
	});

	it("handles an empty biggest list without crashing", () => {
		const b: ContextBreakdown = {
			model: "m",
			systemTokens: 0,
			toolsTokens: 0,
			totalTokens: 0,
			messages: [],
			biggest: [],
		};
		const out = formatBreakdown(b);
		assert.match(out, /messages=0/);
	});
});
