import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
	imageToBlock,
	modelSupportsVision,
	normalizeChatImage,
} from './chat.js';
import { decodeImage, resizeForVision } from './image-resize.js';
import {
	clearTurnImages,
	getTurnImage,
	parkedToolsNeedImages,
	setTurnImages,
} from './turn-images.js';

// A valid 4x4 red PNG, generated with sharp so libpng accepts it.
async function makeRedPngB64(): Promise<string> {
	return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } })
		.png()
		.toBuffer()
		.then((b) => b.toString('base64'));
}

describe('modelSupportsVision', () => {
	it('paith-high is vision-capable', () => {
		assert.equal(modelSupportsVision('paith-high'), true);
	});
	it('paith-low is NOT vision-capable', () => {
		assert.equal(modelSupportsVision('paith-low'), false);
	});
	it('unknown models are not vision-capable', () => {
		assert.equal(modelSupportsVision('claude-sonnet-5'), false);
	});
});

describe('normalizeChatImage', () => {
	it('accepts data + media_type (the frontend shape)', async () => {
		const b64 = await makeRedPngB64();
		const uri = `data:image/png;base64,${b64}`;
		const out = normalizeChatImage({ data: uri, media_type: 'image/png' });
		assert.ok(out);
		assert.equal(out.data, uri);
		assert.equal(out.media_type, 'image/png');
	});

	it('accepts bare base64 + media_type', async () => {
		const b64 = await makeRedPngB64();
		const out = normalizeChatImage({ data: b64, media_type: 'image/png' });
		assert.ok(out);
		assert.equal(out.data, b64);
	});

	it('rejects non-objects and empty payloads', () => {
		assert.equal(normalizeChatImage(null), null);
		assert.equal(normalizeChatImage('not an object'), null);
		assert.equal(normalizeChatImage({}), null);
		assert.equal(normalizeChatImage({ data: '' }), null);
	});

	it('rejects oversized payloads', () => {
		const huge = 'data:image/png;base64,' + 'A'.repeat(20_000_001);
		assert.equal(normalizeChatImage({ data: huge }), null);
	});
});

describe('decodeImage', () => {
	it('decodes a data URI to a valid image buffer', async () => {
		const b64 = await makeRedPngB64();
		const img = normalizeChatImage({ data: `data:image/png;base64,${b64}`, media_type: 'image/png' });
		assert.ok(img);
		const buf = decodeImage(img.data);
		assert.ok(buf.length > 0);
		assert.doesNotThrow(() => sharp(buf));
	});

	it('decodes bare base64', async () => {
		const b64 = await makeRedPngB64();
		const img = normalizeChatImage({ data: b64, media_type: 'image/png' });
		assert.ok(img);
		const buf = decodeImage(img.data);
		assert.ok(buf.length > 0);
		assert.doesNotThrow(() => sharp(buf));
	});

	it('leaves the original full-resolution bytes untouched', async () => {
		// The save path uses decodeImage(img.data) and must never re-encode, so
		// the bytes PHP stores stay bit-identical to what the browser sent.
		const b64 = await makeRedPngB64();
		const original = Buffer.from(b64, 'base64');
		assert.deepEqual(decodeImage(`data:image/png;base64,${b64}`), original);
		assert.deepEqual(decodeImage(b64), original);
	});
});

describe('imageToBlock', () => {
	it('resizes the original and builds a base64 image block', async () => {
		const b64 = await makeRedPngB64();
		const img = normalizeChatImage({ data: `data:image/png;base64,${b64}`, media_type: 'image/png' });
		assert.ok(img);
		const block = await imageToBlock(img);
		assert.ok(block);
		assert.equal(block.type, 'image');
		const src = block.source as { type: string; media_type: string; data: string };
		assert.equal(src.type, 'base64');
		assert.ok(src.media_type === 'image/png' || src.media_type === 'image/jpeg');
		// The resized bytes must decode to a valid 4x4 image (sharp round-trip).
		const meta = await sharp(Buffer.from(src.data, 'base64')).metadata();
		assert.equal(meta.width, 4);
		assert.equal(meta.height, 4);
	});

	it('returns null when the image cannot be decoded', async () => {
		const img = normalizeChatImage({ data: 'not-a-real-image', media_type: 'image/png' });
		assert.ok(img);
		assert.equal(await imageToBlock(img), null);
	});
});

// Token cost of an Anthropic-style vision image scales with PATCHED pixels, so
// the whole point of resizeForVision is bounding the longest side. Without this
// a 4096px screenshot would cost 10k+ tokens.
describe('resizeForVision', () => {
	const MAX_DIMENSION = 1024;

	async function makeImage(
		width: number,
		height: number,
		channels: 3 | 4 = 3,
	): Promise<Buffer> {
		return sharp({
			create: {
				width,
				height,
				channels,
				background:
					channels === 4
						? { r: 255, g: 0, b: 0, alpha: 0.5 }
						: { r: 255, g: 0, b: 0 },
			},
		})
			.png()
			.toBuffer();
	}

	it('caps the longest side at 1024px, preserving aspect ratio', async () => {
		const buf = await makeImage(2000, 1000);
		const out = await resizeForVision(buf);
		const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
		assert.equal(meta.width, MAX_DIMENSION);
		assert.equal(meta.height, 512);
	});

	it('caps a tall portrait image on its longest side', async () => {
		const buf = await makeImage(600, 3000);
		const out = await resizeForVision(buf);
		const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
		assert.equal(meta.height, MAX_DIMENSION);
		assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX_DIMENSION);
	});

	it('never enlarges an image that is already small enough', async () => {
		const buf = await makeImage(200, 100);
		const out = await resizeForVision(buf);
		const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
		assert.equal(meta.width, 200);
		assert.equal(meta.height, 100);
	});

	it('keeps PNG for an image with transparency, JPEG otherwise', async () => {
		const withAlpha = await resizeForVision(await makeImage(1200, 1200, 4));
		assert.equal(withAlpha.mediaType, 'image/png');

		const opaque = await resizeForVision(await makeImage(1200, 1200, 3));
		assert.equal(opaque.mediaType, 'image/jpeg');
	});

	it('accepts a data URI as well as a Buffer', async () => {
		const buf = await makeImage(2000, 2000);
		const out = await resizeForVision(`data:image/png;base64,${buf.toString('base64')}`);
		const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
		assert.equal(meta.width, MAX_DIMENSION);
	});
});

// The full-resolution bytes for a turn live here, NOT in the prompt. The model
// only ever sees an [IMAGE n] index.
describe('turn image stash', () => {
	const convId = '00000000-0000-4000-8000-00000000000a';

	it('stores and reads images by 1-based index', () => {
		setTurnImages(convId, [
			{ data: 'first', media_type: 'image/png' },
			{ data: 'second', media_type: 'image/jpeg' },
		]);
		assert.equal(getTurnImage(convId, 1)?.data, 'first');
		assert.equal(getTurnImage(convId, 2)?.media_type, 'image/jpeg');
		clearTurnImages(convId);
	});

	it('returns null for an out-of-range index or an unknown turn', () => {
		setTurnImages(convId, [{ data: 'only' }]);
		assert.equal(getTurnImage(convId, 2), null);
		assert.equal(getTurnImage(convId, 0), null);
		assert.equal(getTurnImage('no-such-conversation', 1), null);
		clearTurnImages(convId);
	});

	it('is empty again after the turn is cleared', () => {
		setTurnImages(convId, [{ data: 'gone-after-clear' }]);
		clearTurnImages(convId);
		assert.equal(getTurnImage(convId, 1), null);
	});

	it('does not stash an empty image list', () => {
		setTurnImages(convId, []);
		assert.equal(getTurnImage(convId, 1), null);
	});
});

// Regression guard for the approval round-trip. save_image_to_note is a write,
// so it ALWAYS parks on an approval card: the streaming request ends, the user
// clicks approve, and the tool only then executes — in the NEXT request. If the
// stash were released when the stream ended, the tool would find nothing and
// could never succeed, no matter how the frontend posted the image.
describe('approval round-trip keeps the turn stash alive', () => {
	const convId = '00000000-0000-4000-8000-00000000000b';

	it('keeps the stash when the turn parked on save_image_to_note', () => {
		assert.equal(parkedToolsNeedImages(['save_image_to_note']), true);
	});

	it('releases the stash when the parked tools do not need image bytes', () => {
		assert.equal(parkedToolsNeedImages(['create_note', 'update_note']), false);
		assert.equal(parkedToolsNeedImages([]), false);
	});

	it('keeps it when save_image_to_note is one of several parked tools', () => {
		assert.equal(parkedToolsNeedImages(['search_notes', 'save_image_to_note']), true);
	});

	it('the bytes are still readable after the stream that stashed them ends', () => {
		// Mirrors the real sequence: /chat stashes + parks (no clear), then the
		// /chat/tool-result request runs the approved tool.
		setTurnImages(convId, [{ data: 'original-bytes', media_type: 'image/png' }]);
		const parked = parkedToolsNeedImages(['save_image_to_note']);
		if (!parked) clearTurnImages(convId); // what a non-image approval does
		assert.equal(getTurnImage(convId, 1)?.data, 'original-bytes');
		clearTurnImages(convId);
	});
});
