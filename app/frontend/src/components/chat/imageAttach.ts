/**
 * Client-side image handling for chat attachments. Two outputs per source image:
 *   - `original` — the UN-RESIZED bytes (base64). This is the ONLY thing uploaded
 *     to /chat. MCP resizes it server-side for vision and hands the same original
 *     to save_image_to_note, so a saved note always keeps full resolution.
 *   - `preview`  — a locally-resized (≤ MAX_DIMENSION) copy used ONLY to render
 *     the attachment thumbnail and the chat bubble. It is never sent to the
 *     server, so it costs nothing in bandwidth.
 *
 * Format preservation: the ORIGINAL always keeps its true format (that's what
 * gets stored). PNG sources keep their transparency in the preview; anything
 * else re-encodes to JPEG (q≈0.85) for a smaller thumbnail.
 */

export type AttachedImage = {
	/** data: URI of the original, un-resized image — the only bytes uploaded. */
	original: string;
	/** data: URI of the resized copy, used ONLY for local rendering (attachment
	 *  thumbnail + chat bubble). Never sent to the server. */
	preview: string;
	mediaType: "image/png" | "image/jpeg";
	filename: string;
};

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 0.85;

function loadImage(dataUri: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("could not decode image"));
		img.src = dataUri;
	});
}

function encodeCanvas(
	canvas: HTMLCanvasElement,
	mime: string,
	quality?: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("encode failed"));
					return;
				}
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result ?? ""));
				reader.onerror = () => reject(reader.error ?? new Error("read failed"));
				reader.readAsDataURL(blob);
			},
			mime,
			quality,
		);
	});
}

/**
 * Process a single source image (a File/Blob or a data: URI) into the
 * original + preview pair. Preserves PNG (transparency); otherwise the
 * preview is JPEG.
 */
export async function processImageAttachment(
	source: Blob | string,
	filename?: string,
): Promise<AttachedImage> {
	// Normalize the source to a data URI we can load into a canvas.
	let sourceDataUri: string;
	let originalDataUri: string;
	let mediaType: "image/png" | "image/jpeg";

	if (typeof source === "string") {
		sourceDataUri = source;
		originalDataUri = source;
		mediaType = source.startsWith("data:image/png")
			? "image/png"
			: "image/jpeg";
	} else {
		mediaType = source.type === "image/png" ? "image/png" : "image/jpeg";
		const reader = new FileReader();
		sourceDataUri = await new Promise<string>((resolve, reject) => {
			reader.onload = () => resolve(String(reader.result ?? ""));
			reader.onerror = () => reject(reader.error ?? new Error("read failed"));
			reader.readAsDataURL(source);
		});
		originalDataUri = sourceDataUri;
	}

	const img = await loadImage(sourceDataUri);
	const w = img.naturalWidth || img.width;
	const h = img.naturalHeight || img.height;
	if (!w || !h) throw new Error("image has no dimensions");

	// Only re-encode the preview if it actually exceeds the cap; otherwise
	// the source is already small enough and we reuse it as the preview.
	const scale = Math.min(1, MAX_DIMENSION / Math.max(w, h));
	let preview: string;
	if (scale >= 1) {
		preview = originalDataUri;
	} else {
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		// White background for JPEG (no alpha) so transparency doesn't turn
		// black; PNG keeps transparency.
		if (mediaType !== "image/png") {
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		}
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		preview = await encodeCanvas(
			canvas,
			mediaType,
			mediaType === "image/jpeg" ? JPEG_QUALITY : undefined,
		);
	}

	const finalName =
		filename ?? (mediaType === "image/png" ? "image.png" : "image.jpg");

	return {
		original: originalDataUri,
		preview,
		mediaType,
		filename: finalName,
	};
}

/** Pull image Blobs out of a paste/drop event's items. */
export function extractImageBlobs(
	items: Iterable<DataTransferItem> | Iterable<FileListEntryLike> | undefined,
): Blob[] {
	const out: Blob[] = [];
	if (!items) return out;
	for (const item of items) {
		const it = item as {
			kind?: string;
			type?: string;
			getAsFile?: () => File | null;
		};
		if (it.kind === "file" && typeof it.getAsFile === "function") {
			const f = it.getAsFile();
			if (f?.type.startsWith("image/")) out.push(f);
		}
	}
	return out;
}

// FileListEntryLike is not in the DOM lib; we only need the fields we touch.
type FileListEntryLike =
	| DataTransferItem
	| { kind?: string; type?: string; getAsFile?: () => File | null };
