import { createMemo, For, Show } from "solid-js";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

type MentionItem = {
	noteId: string;
	noteTitle: string;
	nookId?: string;
};

export function MentionsAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	fullscreen?: boolean;
}) {
	const direction = () =>
		String(props.attr.config.direction ?? "both") as
			| "outgoing"
			| "incoming"
			| "both";

	const items = createMemo((): MentionItem[] => {
		const noteId = props.store.selectedId();
		if (!noteId) return [];

		const dir = direction();
		const result: MentionItem[] = [];
		const seen = new Set<string>();

		const add = (m: { noteId: string; noteTitle: string; nookId?: string }) => {
			if (seen.has(m.noteId) || m.noteId === noteId) return;
			seen.add(m.noteId);
			result.push(m);
		};

		if (dir === "outgoing" || dir === "both") {
			for (const m of props.store.outgoingMentions()) {
				add({ noteId: m.noteId, noteTitle: m.noteTitle, nookId: m.nookId });
			}
		}
		if (dir === "incoming" || dir === "both") {
			for (const m of props.store.incomingMentions()) {
				add({ noteId: m.noteId, noteTitle: m.noteTitle, nookId: m.nookId });
			}
		}

		result.sort((a, b) => a.noteTitle.localeCompare(b.noteTitle));
		return result;
	});

	return (
		<Show when={items().length > 0}>
			<div style={{ "margin-top": "8px" }}>
				<div
					style={{
						"font-size": "0.7rem",
						"font-weight": "600",
						color: "var(--color-text-secondary)",
						"margin-bottom": "4px",
						"text-transform": "uppercase",
						"letter-spacing": "0.03em",
					}}
				>
					{props.attr.name}
				</div>
				<div style={{ display: "grid", gap: "2px" }}>
					<For each={items()}>
						{(item) => (
							<button
								type="button"
								onClick={() =>
									props.store.onNoteLinkClick(item.noteId, item.nookId)
								}
								style={{
									display: "block",
									width: "100%",
									padding: "4px 8px",
									border: "1px solid var(--color-border-light, #e5e7eb)",
									"border-radius": "4px",
									background: "none",
									"text-align": "left",
									cursor: "pointer",
									"font-size": "0.8rem",
									color: "var(--link-color, #0066cc)",
								}}
							>
								{item.noteTitle || "(untitled)"}
							</button>
						)}
					</For>
				</div>
			</div>
		</Show>
	);
}
