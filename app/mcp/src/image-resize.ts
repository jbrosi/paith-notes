/**
 * Server-side image resize for the VISION path. The frontend sends the
 * original (full-resolution) bytes once; when the model needs to *see* the
 * image, node resizes it on demand with sharp. Saving never touches this —
 * the original goes straight to PHP.
 *
 * Why node resizes (not the browser): a single payload (the original), and the
 * resize happens exactly once, at the moment the vision block is built. Token
 * cost is driven by pixel dimensions, so capping the max dimension bounds it.
 *
 * sharp is imported LAZILY on purpose. It is a native module, so a platform
 * without a matching prebuilt binary (wrong libc/alpine arch) would otherwise
 * throw at import time and take the whole /chat route down with it. Loading it
 * inside resizeForVision() keeps the blast radius to the vision path: the
 * caller already treats a failed resize as "no vision block", so attachments
 * still save at full resolution.
 */

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 85;

export type ResizedImage = {
	/** base64 of the resized image (no data: prefix). */
	base64: string;
	/** mime type of the resized output. */
	mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
};

/** Decode an image `data` (data: URI or bare base64) into a Buffer. */
export function decodeImage(input: Buffer | string): Buffer {
	if (Buffer.isBuffer(input)) return input;
	const s = input.trim();
	if (s.startsWith('data:')) {
		const b64 = s.split('base64,').pop() ?? '';
		return Buffer.from(b64.replace(/\s/g, ''), 'base64');
	}
	return Buffer.from(s.replace(/\s/g, ''), 'base64');
}

/** Minimal structural type for the sharp bits we use, so the lazy import
 *  doesn't leak the module's types into this file's signatures. */
type SharpInstance = {
	rotate: () => SharpInstance;
	metadata: () => Promise<{ width?: number; height?: number; hasAlpha?: boolean; format?: string }>;
	resize: (w: number, h: number, opts: { withoutEnlargement: boolean }) => SharpInstance;
	png: () => { toBuffer: () => Promise<Buffer> };
	flatten: (opts: { background: { r: number; g: number; b: number } }) => SharpInstance;
	jpeg: (opts: { quality: number }) => { toBuffer: () => Promise<Buffer> };
};

type SharpFactory = (input: Buffer) => SharpInstance;

/**
 * Decode an original image (Buffer or base64 string) and resize it so its
 * longest side is ≤ MAX_DIMENSION. Preserves alpha as PNG when the source
 * has transparency (JPEG can't); otherwise JPEG (smaller).
 */
export async function resizeForVision(
	input: Buffer | string,
): Promise<ResizedImage> {
	const { default: sharp } = (await import('sharp')) as unknown as {
		default: SharpFactory;
	};
	const buf = decodeImage(input);

	const metadata = await sharp(buf).rotate().metadata();
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	if (!width || !height) {
		throw new Error('image has no dimensions');
	}

	const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
	const resizeTo = (p: SharpInstance) =>
		p.resize(Math.round(width * scale), Math.round(height * scale), {
			withoutEnlargement: true,
		});

	// Keep PNG only when it has alpha (transparency) — JPEG can't. Otherwise
	// JPEG is smaller and fine for the model to look at. If the preferred
	// encode ever fails on an odd input, fall back to the other format.
	const encode = async (fmt: 'png' | 'jpeg'): Promise<Buffer> => {
		const base = resizeTo(sharp(buf).rotate());
		if (fmt === 'png') return base.png().toBuffer();
		return base
			.flatten({ background: { r: 255, g: 255, b: 255 } })
			.jpeg({ quality: JPEG_QUALITY })
			.toBuffer();
	};

	const wantPng = metadata.hasAlpha === true && metadata.format === 'png';
	try {
		const out = await encode(wantPng ? 'png' : 'jpeg');
		return {
			base64: out.toString('base64'),
			mediaType: wantPng ? 'image/png' : 'image/jpeg',
		};
	} catch {
		const out = await encode(wantPng ? 'jpeg' : 'png');
		return {
			base64: out.toString('base64'),
			mediaType: wantPng ? 'image/jpeg' : 'image/png',
		};
	}
}