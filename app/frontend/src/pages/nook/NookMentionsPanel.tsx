import { useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import { useNotePreview, useNoteResolver } from "./NookContext";
import type { Mention, NoteSummary } from "./types";

export type NookMentionsPanelProps = {
	nookId: string;
	notes: NoteSummary[];
	outgoing: Mention[];
	incoming: Mention[];
	onOpenNote: (noteId: string) => void;
};

export function NookMentionsPanel(props: NookMentionsPanelProps) {
	const notePreview = useNotePreview();
	const navigate = useNavigate();
	const resolver = useNoteResolver();

	const isCrossNook = (m: Mention) =>
		m.nookId !== "" && m.nookId !== props.nookId;

	const nookLabel = (m: Mention) => {
		if (!isCrossNook(m)) return "";
		return resolver.resolveNookName(m.nookId) || "another nook";
	};

	const handleClick = (m: Mention) => {
		if (isCrossNook(m)) {
			navigate(
				`/nooks/${encodeURIComponent(m.nookId)}/notes/${encodeURIComponent(m.noteId)}`,
			);
		} else {
			props.onOpenNote(m.noteId);
		}
	};

	const renderMention = (m: Mention, showLinkTitle: boolean) => {
		const crossNook = isCrossNook(m);
		const nook = nookLabel(m);
		const title = showLinkTitle ? m.linkTitle || m.noteTitle : m.noteTitle;

		return (
			<div style={{ padding: "3px 0", "font-size": "0.8rem", display: "flex", "align-items": "baseline", gap: "4px", "flex-wrap": "wrap" }}>
				<span
					style={{
						color: "var(--link-color, #0066cc)",
						cursor: "pointer",
						"font-weight": "500",
					}}
					onClick={() => handleClick(m)}
					onMouseEnter={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						notePreview?.show(m.noteId, rect.left, rect.bottom, {
							onOpen: crossNook ? undefined : () => handleClick(m),
							nookId: crossNook ? m.nookId : undefined,
						});
					}}
					onMouseLeave={() => notePreview?.hide()}
				>
					{title}
				</span>
				<Show when={showLinkTitle && m.linkTitle && m.noteTitle !== m.linkTitle}>
					<span style={{ color: "var(--color-text-faint)", "font-size": "0.7rem" }}>
						({m.noteTitle})
					</span>
				</Show>
				<Show when={crossNook}>
					<span style={{ color: "var(--color-text-faint)", "font-size": "0.65rem" }}>
						in {nook}
					</span>
				</Show>
			</div>
		);
	};

	return (
		<Show when={props.outgoing.length > 0 || props.incoming.length > 0}>
			<div style={{ "margin-top": "0.75rem" }}>
				<div style={{ "font-weight": "600", "font-size": "0.85rem", color: "var(--color-text-secondary)", "margin-bottom": "6px" }}>
					Mentions
				</div>
				<div style={{ display: "flex", gap: "16px" }}>
					<Show when={props.outgoing.length > 0}>
						<div style={{ flex: "1", "min-width": "0" }}>
							<div style={{ color: "var(--color-text-muted)", "font-size": "0.7rem", "font-weight": "500", "text-transform": "uppercase", "letter-spacing": "0.03em", "margin-bottom": "2px" }}>
								Outgoing
							</div>
							<For each={props.outgoing}>{(m) => renderMention(m, true)}</For>
						</div>
					</Show>
					<Show when={props.incoming.length > 0}>
						<div style={{ flex: "1", "min-width": "0" }}>
							<div style={{ color: "var(--color-text-muted)", "font-size": "0.7rem", "font-weight": "500", "text-transform": "uppercase", "letter-spacing": "0.03em", "margin-bottom": "2px" }}>
								Incoming
							</div>
							<For each={props.incoming}>{(m) => renderMention(m, false)}</For>
						</div>
					</Show>
				</div>
			</div>
		</Show>
	);
}
