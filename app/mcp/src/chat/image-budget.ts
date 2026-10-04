import type Anthropic from "@anthropic-ai/sdk";

/**
 * Bound the pixels a conversation carries in its history.
 *
 * Every `look_at_image` call puts a real Anthropic `image` block into a
 * tool_result, and tool_results are persisted and re-sent on every later turn.
 * That is what makes "I already looked at this picture twenty messages ago"
 * work — but it is also an unbounded growth path the attachment feature did not
 * have: the model can re-look at the same image every turn, and each copy is
 * ~1.5k tokens of pixels that nothing ever removes. Fifty re-looks is ~75k
 * tokens of a picture the model already described in the transcript.
 *
 * So: keep the pixels the model is most likely to still be reasoning about
 * (the most recent ones, and only one copy of any given image), and replace the
 * rest with a text stub naming the id to re-look at. Losing old pixels costs
 * nothing in practice — `look_at_image` is auto-approved and re-fetches from the
 * attachment store in milliseconds — while keeping them costs context forever.
 *
 * Applied to the REQUEST copy only, never written back to the DB, so the stored
 * transcript (and what the UI can show) stays untouched — same approach as
 * sanitizeOrphanedToolUses.
 */

/** Text substituted for a dropped image block. */
export const DROPPED_IMAGE_NOTICE =
	"[the pixels of this image were dropped from earlier history to bound context cost — " +
	"call look_at_image again with the same image_id / note_id to see it again]";

export type ImageBudgetOptions = {
	/**
	 * How many distinct image blocks to keep in the request. Four covers "the
	 * images in this turn plus the couple I was just asked about", which is what
	 * the model actually needs visible at once.
	 */
	keep?: number;
};

/**
 * Drop stale image blocks from tool_results, newest first.
 *
 * Only touches `image` blocks that live inside a `tool_result` content array —
 * those are look_at_image outputs. Image blocks in a user turn are the user's
 * own pasted attachments: they are bounded by how many times the user pasted,
 * the UI shows them, and stripping them would hide something the user can
 * plainly see in the transcript.
 */
export function stripStaleImageBlocks(
	messages: Anthropic.MessageParam[],
	opts: ImageBudgetOptions = {},
): Anthropic.MessageParam[] {
	const keep = opts.keep ?? 4;
	if (keep < 0) return messages;

	// Pass 1: collect every tool_result image block, newest occurrence of each
	// distinct payload last, so a re-look at the SAME image counts once.
	const seen = new Set<string>();
	const survivors = new Set<Anthropic.ToolResultBlockParam>();
	let found = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i].content;
		if (messages[i].role !== "user" || !Array.isArray(content)) continue;
		for (const block of content) {
			if (!isToolResultWithImages(block)) continue;
			for (const inner of block.content) {
				if (inner.type !== "image") continue;
				found++;
				const key = imageKey(inner);
				if (seen.has(key)) continue; // an older duplicate of the same picture
				seen.add(key);
				if (survivors.size < keep) survivors.add(block);
			}
		}
	}

	// No tool_result pixels anywhere (the common case) → hand back the very same
	// array, so the common path allocates nothing. `found` rather than
	// `survivors.size`, because `keep: 0` legitimately means "drop them all".
	if (found === 0) return messages;

	// Pass 2: rebuild, swapping image blocks out of everything that didn't make
	// the cut.
	return messages.map((msg) => {
		const content = msg.content;
		if (msg.role !== "user" || !Array.isArray(content)) return msg;
		if (!content.some((b) => isToolResultWithImages(b) && !survivors.has(b)))
			return msg;

		return {
			...msg,
			content: content.map((block) => {
				if (!isToolResultWithImages(block) || survivors.has(block))
					return block;
				return {
					...block,
					content: block.content.map((inner) =>
						inner.type === "image"
							? { type: "text" as const, text: DROPPED_IMAGE_NOTICE }
							: inner,
					),
				};
			}),
		};
	});
}

function isToolResultWithImages(
	block: unknown,
): block is Anthropic.ToolResultBlockParam & {
	content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;
} {
	if (typeof block !== "object" || block === null) return false;
	const b = block as { type?: unknown; content?: unknown };
	return b.type === "tool_result" && Array.isArray(b.content);
}

/** Identity of a picture: the payload itself, so equal bytes == equal image. */
function imageKey(block: Anthropic.ImageBlockParam): string {
	const src = block.source as { type?: string; data?: string } | undefined;
	return `${src?.type ?? "?"}:${src?.data?.length ?? 0}:${src?.data?.slice(0, 64) ?? ""}`;
}
