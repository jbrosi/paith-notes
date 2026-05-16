import { useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import { ActorLabel } from "../../../components/ActorLabel";
import { useNotePreview } from "../NookContext";
import type { NookStore } from "../store";
import styles from "./TitleSection.module.css";

export function NoteHistory(props: { store: NookStore }) {
	const navigate = useNavigate();
	const notePreview = useNotePreview();
	const history = () => props.store.noteHistory();

	const formatDate = (iso: string) => {
		try {
			const d = new Date(iso);
			return d.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	};

	const actionLabel = (action: string, type: string) => {
		if (type === "link") {
			if (action === "INSERT") return "linked";
			if (action === "DELETE") return "unlinked";
			return "updated link";
		}
		if (action === "INSERT") return "created";
		if (action === "UPDATE") return "edited";
		if (action === "DELETE") return "deleted";
		return action.toLowerCase();
	};


	return (
		<Show when={history().length > 0}>
			<div
				id="note-history-section"
				style={{
					"font-size": "0.75rem",
					color: "#888",
					"padding-top": "0.75rem",
					"border-top": "1px solid #eee",
					"margin-top": "1rem",
				}}
			>
				<For each={history()}>
					{(entry) => (
						<div style={{ "margin-bottom": "0.35rem", display: "flex", "align-items": "baseline", gap: "4px", "flex-wrap": "wrap" }}>
							<span style={{ "font-weight": "500", color: "#666" }}>
								<ActorLabel actor={entry.actor} userName={entry.userName} />
							</span>
							<span>{actionLabel(entry.action, entry.type)}</span>
							{entry.type === "link" && entry.linkedNoteTitle ? (
								<span
									style={{
										"font-weight": "500",
										color: "var(--link-color, #0066cc)",
										cursor: "pointer",
									}}
									onClick={() => {
										if (entry.linkedNoteId) {
											void props.store.onNoteLinkClick(entry.linkedNoteId);
										}
									}}
									onMouseEnter={(e) => {
										if (!entry.linkedNoteId || !notePreview) return;
										const rect = e.currentTarget.getBoundingClientRect();
										notePreview.show(entry.linkedNoteId, rect.left, rect.bottom, {
											onOpen: (id) => void props.store.onNoteLinkClick(id),
										});
									}}
									onMouseLeave={() => notePreview?.hide()}
								>
									{entry.linkedNoteTitle}
								</span>
							) : null}
							{entry.type === "note" ? (
								<span
									class={styles.versionBadge}
									onClick={() => {
										const nook = props.store.nookId();
										const noteId = props.store.selectedId();
										if (nook && noteId) {
											navigate(`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}/v/${entry.version}`);
										}
									}}
									title={`View version ${entry.version}`}
								>
									v{entry.version}
								</span>
							) : null}
							<span style={{ color: "#aaa" }}>
								{formatDate(entry.createdAt)}
							</span>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}
