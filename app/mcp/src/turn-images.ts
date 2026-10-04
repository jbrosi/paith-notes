/**
 * Per-turn stash of attached images (ORIGINAL full-res bytes).
 *
 * Lives in its own module (no dependencies) to avoid a circular import:
 * chat.ts → chat-tools.ts → (image-save.ts) → chat.ts. The store is set by the
 * /chat route, read by the save_image_to_note tool, and cleared when the turn
 * ends. The model only passes a small [IMAGE n] index; the bytes never travel
 * through the LLM prompt.
 */

export type StoredChatImage = {
	data: string;
	media_type?: string;
};

type Entry = { images: StoredChatImage[]; ts: number };
const TURN_IMAGES = new Map<string, Entry>();
const TTL_MS = 10 * 60 * 1000; // 10 min safety net
let cleanupScheduled = false;

export function setTurnImages(
	conversationId: string,
	images: StoredChatImage[],
): void {
	if (images.length === 0) return;
	TURN_IMAGES.set(conversationId, { images, ts: Date.now() });
	if (!cleanupScheduled) {
		cleanupScheduled = true;
		setTimeout(() => {
			cleanupScheduled = false;
			const now = Date.now();
			for (const [key, entry] of TURN_IMAGES) {
				if (now - entry.ts > TTL_MS) TURN_IMAGES.delete(key);
			}
		}, 60 * 1000);
	}
}

export function getTurnImage(
	conversationId: string,
	index: number,
): StoredChatImage | null {
	const entry = TURN_IMAGES.get(conversationId);
	return entry?.images[index - 1] ? entry.images[index - 1] : null;
}

export function clearTurnImages(conversationId: string): void {
	TURN_IMAGES.delete(conversationId);
}

/**
 * Tools that resolve image bytes out of this stash instead of receiving them in
 * their arguments.
 */
const TURN_IMAGE_TOOLS = new Set(["save_image_to_note"]);

/**
 * Whether a turn that parked on an approval card must keep its stash.
 *
 * Approved tools do NOT run in the same request — the stream ends, the user
 * clicks approve, and execution happens in the next one. So a turn that parks
 * on save_image_to_note has to keep the bytes across that gap, or the tool
 * wakes up to an empty stash and can never succeed. A turn parked on anything
 * else can drop the bytes immediately.
 */
export function parkedToolsNeedImages(toolNames: readonly string[]): boolean {
	return toolNames.some((name) => TURN_IMAGE_TOOLS.has(name));
}
