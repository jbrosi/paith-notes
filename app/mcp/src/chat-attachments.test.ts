import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type Anthropic from '@anthropic-ai/sdk';
import {
	storeAttachments,
	normalizeImageMediaType,
	sniffImageMediaType,
	fetchAttachmentBytes,
} from './chat-attachments.js';
import { executeTool } from './chat-tools.js';
import { imageViewTools } from './tools/image-view.js';
import { imageSaveTools } from './tools/image-save.js';
import { optionalToolDefinitions, optionalAutoApprovedTools } from './tools/registry.js';
import type { ToolHandlerContext, ToolResultBlocks } from './tools/types.js';

// Every test here stubs global fetch — no LLM, no PHP, no network, ever.

type Call = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let respond: (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
}

beforeEach(() => {
	calls = [];
	respond = () => new Response('', { status: 404 });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init });
		return await respond(url);
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function redPng(size = 4): Promise<Buffer> {
	return sharp({ create: { width: size, height: size, channels: 3, background: { r: 255, g: 0, b: 0 } } })
		.png()
		.toBuffer();
}

function ctx(over: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
	return {
		apiBaseUrl: 'http://api.test',
		cookie: 'session=abc',
		nookId: 'nook-1',
		conversationId: 'conv-1',
		model: 'paith-high',
		...over,
	};
}

function runLook(input: Record<string, unknown>, context: ToolHandlerContext = ctx()) {
	return imageViewTools.handlers.look_at_image(input, context);
}

function blocksOf(result: Awaited<ReturnType<typeof runLook>>): ToolResultBlocks {
	assert.ok(Array.isArray(result), 'expected a block array, not a string');
	return result;
}

describe('storeAttachments', () => {
	it('POSTs the turn images and returns the stored rows in order', async () => {
		respond = () =>
			jsonResponse({
				images: [
					{ id: 'uuid-1', attachment_index: 1, filename: 'a.png', media_type: 'image/png', filesize: 3 },
					{ id: 'uuid-2', attachment_index: 2, filename: 'b.jpg', media_type: 'image/jpeg', filesize: 4 },
				],
			});
		const rows = await storeAttachments('conv-1', [
			{ data: 'AAA', media_type: 'image/png', filename: 'a.png' },
			{ data: 'BBB', media_type: 'image/jpeg' },
		], { apiBase: 'http://api.test', cookie: 'session=abc', turnId: 'turn-9', nookId: 'nook-1' });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, 'http://api.test/api/conversations/conv-1/images');
		assert.equal(calls[0].init?.method, 'POST');
		assert.equal((calls[0].init?.headers as Record<string, string>)['X-Nook-Actor'], 'ai');
		const body = JSON.parse(String(calls[0].init?.body));
		assert.equal(body.images.length, 2);
		assert.equal(body.images[0].data, 'AAA');
		assert.equal(body.images[1].filename, undefined, 'a missing filename must not be sent as null');
		assert.equal(body.turn_id, 'turn-9');
		assert.equal(body.nook_id, 'nook-1');

		assert.deepEqual(
			rows.map((r) => [r.id, r.attachment_index]),
			[['uuid-1', 1], ['uuid-2', 2]],
		);
	});

	it('throws with the API status and body so /chat can fall back', async () => {
		respond = () => new Response('nope', { status: 507 });
		await assert.rejects(
			storeAttachments('conv-1', [{ data: 'AAA', media_type: 'image/png' }], {
				apiBase: 'http://api.test',
				cookie: '',
			}),
			/API 507 POST \/conversations\/conv-1\/images: nope/,
		);
	});

	it('rejects a non-JSON body instead of silently storing nothing', async () => {
		respond = () => new Response('<html>502</html>', { status: 200 });
		await assert.rejects(
			storeAttachments('conv-1', [{ data: 'AAA' }], { apiBase: 'http://api.test', cookie: '' }),
			/non-JSON/,
		);
	});

	it('drops malformed rows rather than handing the model a bogus id', async () => {
		respond = () =>
			jsonResponse({ images: [{ id: 'good', attachment_index: 1 }, { attachment_index: 2 }, null, 'x'] });
		const rows = await storeAttachments('conv-1', [{ data: 'A' }], { apiBase: 'http://api.test', cookie: '' });
		assert.deepEqual(rows.map((r) => r.id), ['good']);
	});
});

describe('media type helpers', () => {
	it('normalizes content-type parameters and the jpg alias', () => {
		assert.equal(normalizeImageMediaType('image/PNG; charset=binary'), 'image/png');
		assert.equal(normalizeImageMediaType('image/jpg'), 'image/jpeg');
		assert.equal(normalizeImageMediaType('image/gif'), null);
	});

	it('sniffs png/jpeg/webp magic numbers', () => {
		assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
		assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
		assert.equal(
			sniffImageMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
			'image/webp',
		);
		assert.equal(sniffImageMediaType(Buffer.from('not an image at all')), null);
	});

	it('falls back to sniffing when the API sends no usable mime header', async () => {
		const png = await redPng();
		respond = () => new Response(new Uint8Array(png), { status: 200, headers: { 'Content-Type': 'text/html' } });
		const got = await fetchAttachmentBytes('conv-1', 'uuid-1', { apiBase: 'http://api.test', cookie: '' });
		assert.equal(got.mediaType, 'image/png');
		assert.deepEqual(got.buffer, png);
	});
});

describe('look_at_image', () => {
	it('is registered and auto-approved, so looking at a picture needs no click', () => {
		const names = optionalToolDefinitions.map((t) => t.name);
		assert.ok(names.includes('look_at_image'), `expected look_at_image in ${names.join(', ')}`);
		assert.ok(optionalAutoApprovedTools.has('look_at_image'));
	});

	it('returns real pixels for a chat attachment from ANY turn', async () => {
		const png = await redPng(8);
		respond = (url) => {
			assert.equal(url, 'http://api.test/api/conversations/conv-1/images/uuid-old');
			return new Response(new Uint8Array(png), {
				status: 200,
				headers: { 'Content-Type': 'image/png', 'X-Image-Mime': 'image/png', 'X-Image-Filename': 'shot.png' },
			});
		};
		const blocks = blocksOf(await runLook({ image_id: 'uuid-old' }));

		assert.equal(blocks.length, 2);
		const [text, image] = blocks;
		assert.equal((text as Anthropic.TextBlockParam).type, 'text');
		assert.match((text as Anthropic.TextBlockParam).text, /chat attachment uuid-old/);
		assert.match((text as Anthropic.TextBlockParam).text, /shot\.png/, 'the model should know what it is looking at');
		assert.equal((image as Anthropic.ImageBlockParam).type, 'image');
		const src = (image as Anthropic.ImageBlockParam).source as Anthropic.Base64ImageSource;
		assert.equal(src.type, 'base64');
		// The block must be a real, decodable image — not just well-typed JSON.
		const meta = await sharp(Buffer.from(src.data, 'base64')).metadata();
		assert.equal(meta.width, 8);
	});

	it('looks at the CURRENT image of a note via note_id', async () => {
		const png = await redPng(6);
		respond = (url) => {
			assert.equal(url, 'http://api.test/api/nooks/nook-1/notes/note-7/image');
			return new Response(new Uint8Array(png), { status: 200, headers: { 'Content-Type': 'image/png' } });
		};
		const blocks = blocksOf(await runLook({ note_id: 'note-7' }));
		assert.equal(blocks.length, 2);
		assert.match((blocks[0] as Anthropic.TextBlockParam).text, /note note-7/);
	});

	it('uses an explicit nook_id for a note in another nook', async () => {
		respond = async (url) => {
			assert.equal(url, 'http://api.test/api/nooks/nook-2/notes/note-7/image');
			return new Response(new Uint8Array(await redPng()), { status: 200, headers: { 'Content-Type': 'image/png' } });
		};
		await runLook({ note_id: 'note-7', nook_id: 'nook-2' });
		assert.equal(calls.length, 1);
	});

	it('refuses on a text-only model WITHOUT fetching, and says so honestly', async () => {
		const out = await runLook({ image_id: 'uuid-1' }, ctx({ model: 'paith-low' }));
		assert.equal(typeof out, 'string');
		assert.match(String(out), /paith-low has no vision capability/);
		assert.match(String(out), /Do NOT describe or guess/);
		assert.match(String(out), /Paith High/);
		assert.equal(calls.length, 0, 'a blind model must not pay for a pointless download');
	});

	it('surfaces a 404 instead of pretending the image exists', async () => {
		respond = () => new Response('{"error":"not found"}', { status: 404 });
		await assert.rejects(runLook({ image_id: 'gone' }), /API 404 GET \/conversations\/conv-1\/images\/gone/);
	});

	it('turns undecodable bytes into an actionable error, not a fake image', async () => {
		respond = () => new Response('this is not an image', { status: 200, headers: { 'Content-Type': 'image/png' } });
		await assert.rejects(runLook({ image_id: 'broken' }), /could not decode chat attachment broken/);
	});

	it('requires an image_id or a note_id', async () => {
		await assert.rejects(runLook({}), /pass image_id.*or note_id/);
		assert.equal(calls.length, 0);
	});

	it('refuses a note lookup with no nook rather than guessing', async () => {
		await assert.rejects(runLook({ note_id: 'note-7' }, ctx({ nookId: '' })), /note_id needs a nook/);
	});
});

describe('save_image_to_note prefers the durable attachment', () => {
	it('copies server-side from attachment_id instead of re-sending base64', async () => {
		respond = () => jsonResponse({ note_id: 'note-42', embed: '![shot](note:note-42)' });
		const out = await imageSaveTools.handlers.save_image_to_note(
			{ attachment_id: 'uuid-7', title: 'Shot' },
			ctx({ model: 'paith-low' }),
		);
		assert.match(String(out), /note-42/);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, 'http://api.test/api/nooks/nook-1/chat-images/from-attachment');
		const body = JSON.parse(String(calls[0].init?.body));
		assert.equal(body.attachment_id, 'uuid-7');
		assert.equal(body.title, 'Shot');
		assert.equal(body.image_data, undefined, 'the durable copy must NOT resend bytes through the model');
	});

	it('attaches to an existing note when note_id is given', async () => {
		respond = () => jsonResponse({ note_id: 'note-9' });
		await imageSaveTools.handlers.save_image_to_note(
			{ attachment_id: 'uuid-7', note_id: 'note-9' },
			ctx(),
		);
		const body = JSON.parse(String(calls[0].init?.body));
		assert.equal(body.note_id, 'note-9');
		assert.equal(body.title, undefined, 'a title would rename the target note');
	});

	it('saving works on a text-only model — no vision needed', async () => {
		respond = () => jsonResponse({ note_id: 'note-42' });
		const out = await imageSaveTools.handlers.save_image_to_note({ attachment_id: 'uuid-7' }, ctx({ model: 'paith-low' }));
		assert.match(String(out), /note-42/);
		assert.equal(calls.length, 1);
	});

	it('reports an API failure with status and body', async () => {
		respond = () => new Response('{"error":"attachment not in conversation"}', { status: 409 });
		await assert.rejects(
			imageSaveTools.handlers.save_image_to_note({ attachment_id: 'uuid-x' }, ctx()),
			/API 409 POST \/nooks\/nook-1\/chat-images\/from-attachment/,
		);
	});

	it('refuses to guess an id-less attachment instead of looping', async () => {
		await assert.rejects(
			imageSaveTools.handlers.save_image_to_note({ attachment_id: '   ' }, ctx()),
			/provide attachment_id/,
		);
		assert.equal(calls.length, 0);
	});
});
// Regression guard for the plumbing that makes the vision gate work. The model
// reaches look_at_image through executeTool(); if a call site forgets the
// trailing `model` argument, ctx.model is undefined, modelSupportsVision('')
// is false, and the model is told it cannot see images on a model that can —
// permanently, and with no error to notice it by.
describe('executeTool forwards the model into look_at_image', () => {
	it('refuses on paith-low (model forwarded, no download)', async () => {
		const out = await executeTool('look_at_image', { image_id: 'uuid-1' }, 'http://api.test', '', 'nook-1', undefined, 'conv-1', 'paith-low');
		assert.equal(typeof out, 'string');
		assert.match(String(out), /paith-low has no vision capability/);
		assert.equal(calls.length, 0);
	});

	it('returns pixels on paith-high (model forwarded)', async () => {
		respond = async () =>
			new Response(new Uint8Array(await redPng(5)), {
				status: 200,
				headers: { 'Content-Type': 'image/png' },
			});
		const out = await executeTool('look_at_image', { image_id: 'uuid-1' }, 'http://api.test', '', 'nook-1', undefined, 'conv-1', 'paith-high');
		const blocks = blocksOf(out as Awaited<ReturnType<typeof runLook>>);
		assert.equal(blocks.length, 2);
		assert.equal((blocks[1] as Anthropic.ImageBlockParam).type, 'image');
	});
});
