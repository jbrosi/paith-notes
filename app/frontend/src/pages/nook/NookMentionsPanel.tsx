import { For, Show } from "solid-js";
import type { NotePreviewController } from "./NookDefaultLayout";
import styles from "./NookMentionsPanel.module.css";
import type { Mention, NoteSummary } from "./types";

export type NookMentionsPanelProps = {
	notes: NoteSummary[];
	outgoing: Mention[];
	incoming: Mention[];
	onOpenNote: (noteId: string) => void;
	notePreview?: NotePreviewController;
};

export function NookMentionsPanel(props: NookMentionsPanelProps) {
	const noteTypeLabel = (noteId: string) => {
		const t = props.notes.find((n) => n.id === noteId)?.type;
		return t === "person" ? "Person" : t === "file" ? "File" : "Note";
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
						<For each={props.outgoing}>
							{(m) => (
								<button
									type="button"
									class={styles.mentionBtn}
									onClick={() => props.onOpenNote(m.noteId)}
									onMouseEnter={(e) =>
										props.notePreview?.show(m.noteId, e.clientX, e.clientY, {
											onOpen: (id) => props.onOpenNote(id),
										})
									}
									onMouseLeave={() => props.notePreview?.hide()}
								>
									<div class={styles.mentionTitle}>
										{m.linkTitle || m.noteTitle}
									</div>
									<div class={styles.mentionMeta}>
										<div class={styles.mentionSubtitle}>{m.noteTitle}</div>
										<span class={styles.typeBadge}>
											{noteTypeLabel(m.noteId)}
										</span>
									</div>
								</button>
							)}
						</For>
					</Show>
				</div>
				<div class={styles.column}>
					<div class={styles.columnTitle}>Incoming</div>
					<Show
						when={props.incoming.length > 0}
						fallback={<div class={styles.empty}>None</div>}
					>
						<For each={props.incoming}>
							{(m) => (
								<button
									type="button"
									class={styles.mentionBtn}
									onClick={() => props.onOpenNote(m.noteId)}
									onMouseEnter={(e) =>
										props.notePreview?.show(m.noteId, e.clientX, e.clientY, {
											onOpen: (id) => props.onOpenNote(id),
										})
									}
									onMouseLeave={() => props.notePreview?.hide()}
								>
									<div class={styles.mentionMeta}>
										<div class={styles.mentionTitle}>{m.noteTitle}</div>
										<span class={styles.typeBadge}>
											{noteTypeLabel(m.noteId)}
										</span>
									</div>
									<div class={styles.mentionSubtitle}>{m.linkTitle}</div>
								</button>
							)}
						</For>
					</Show>
				</div>
			</div>
		</div>
	);
}
