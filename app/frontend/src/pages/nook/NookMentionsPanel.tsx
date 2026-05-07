import { useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import { useNoteResolver } from "./NookContext";
import type { NotePreviewController } from "./NookDefaultLayout";
import styles from "./NookMentionsPanel.module.css";
import type { Mention, NoteSummary } from "./types";

export type NookMentionsPanelProps = {
	nookId: string;
	notes: NoteSummary[];
	outgoing: Mention[];
	incoming: Mention[];
	onOpenNote: (noteId: string) => void;
	notePreview?: NotePreviewController;
};

export function NookMentionsPanel(props: NookMentionsPanelProps) {
	const navigate = useNavigate();
	const resolver = useNoteResolver();

	const noteTypeLabel = (noteId: string) => {
		const t = props.notes.find((n) => n.id === noteId)?.type;
		return t === "person" ? "Person" : t === "file" ? "File" : "Note";
	};

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
		return (
			<button
				type="button"
				class={`${styles.mentionBtn} ${crossNook ? styles.crossNook : ""}`}
				onClick={(e) => {
					const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
					const actions = crossNook
						? [
								{
									label: `Open in ${nook}`,
									onClick: () => handleClick(m),
								},
							]
						: [];
					props.notePreview?.show(m.noteId, rect.left, rect.bottom, {
						immediate: true,
						onOpen: crossNook ? undefined : () => handleClick(m),
						nookId: crossNook ? m.nookId : undefined,
						actions,
					});
				}}
				onMouseEnter={(e) => {
					const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
					props.notePreview?.show(m.noteId, rect.left, rect.bottom, {
						onOpen: crossNook ? undefined : () => handleClick(m),
						nookId: crossNook ? m.nookId : undefined,
					});
				}}
				onMouseLeave={() => props.notePreview?.hide()}
			>
				<div class={styles.mentionTitle}>
					{showLinkTitle ? m.linkTitle || m.noteTitle : m.noteTitle}
				</div>
				<div class={styles.mentionMeta}>
					<Show when={showLinkTitle && m.linkTitle}>
						<div class={styles.mentionSubtitle}>{m.noteTitle}</div>
					</Show>
					<Show when={!showLinkTitle && m.linkTitle}>
						<div class={styles.mentionSubtitle}>{m.linkTitle}</div>
					</Show>
					<span class={styles.typeBadge}>{noteTypeLabel(m.noteId)}</span>
				</div>
				<Show when={crossNook}>
					<div class={styles.crossNookLabel}>
						<svg
							aria-hidden="true"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
							<polyline points="15 3 21 3 21 9" />
							<line x1="10" y1="14" x2="21" y2="3" />
						</svg>
						{nook}
					</div>
				</Show>
			</button>
		);
	};

	return (
		<div class={styles.container}>
			<div class={styles.title}>Mentions</div>
			<div class={styles.columns}>
				<div class={styles.column}>
					<div class={styles.columnTitle}>Outgoing</div>
					<Show
						when={props.outgoing.length > 0}
						fallback={<div class={styles.empty}>None</div>}
					>
						<For each={props.outgoing}>{(m) => renderMention(m, true)}</For>
					</Show>
				</div>
				<div class={styles.column}>
					<div class={styles.columnTitle}>Incoming</div>
					<Show
						when={props.incoming.length > 0}
						fallback={<div class={styles.empty}>None</div>}
					>
						<For each={props.incoming}>{(m) => renderMention(m, false)}</For>
					</Show>
				</div>
			</div>
		</div>
	);
}
