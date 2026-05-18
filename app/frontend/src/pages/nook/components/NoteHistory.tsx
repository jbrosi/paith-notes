import { A, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";
import { NoteActivityFeed } from "../../../components/NoteActivityFeed";
import { useNotePreview } from "../NookContext";
import type { NookStore } from "../store";

export function NoteHistory(props: { store: NookStore }) {
	const navigate = useNavigate();
	const notePreview = useNotePreview();

	return (
		<Show when={props.store.noteHistory().length > 0}>
			<NoteActivityFeed
				entries={props.store.noteHistory()}
				buildNoteHref={(noteId) =>
					`/nooks/${encodeURIComponent(props.store.nookId())}/notes/${encodeURIComponent(noteId)}`
				}
				onViewVersion={(version) => {
					const nook = props.store.nookId();
					const noteId = props.store.selectedId();
					if (nook && noteId) {
						navigate(
							`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}/v/${version}`,
						);
					}
				}}
				onNoteHover={(noteId, x, y) => {
					notePreview?.show(noteId, x, y, {
						onOpen: (id) => void props.store.onNoteLinkClick(id),
					});
				}}
				onNoteLeave={() => notePreview?.hide()}
			/>
			<A
				href={`/nooks/${encodeURIComponent(props.store.nookId())}/notes/${encodeURIComponent(props.store.selectedId())}/history`}
				style={{
					"font-size": "0.7rem",
					"margin-top": "6px",
					display: "inline-block",
					color: "var(--link-color, #0066cc)",
					"text-decoration": "none",
				}}
			>
				Show full history
			</A>
		</Show>
	);
}
