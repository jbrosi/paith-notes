import { A, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";
import { Button } from "../../components/Button";
import { NoteActivityFeed } from "../../components/NoteActivityFeed";
import { useNotePreview } from "./NookContext";
import type { NookStore } from "./store";

type Props = {
	store: NookStore;
};

export function NookNoteHistoryPage(props: Props) {
	const navigate = useNavigate();
	const notePreview = useNotePreview();

	const nookId = () => props.store.nookId();
	const noteId = () => props.store.selectedId();
	const noteTitle = () => props.store.title() || "(untitled)";

	return (
		<div style={{ padding: "1.5rem", "max-width": "600px" }}>
			<div
				style={{
					display: "flex",
					"align-items": "center",
					"justify-content": "space-between",
					"margin-bottom": "0.5rem",
				}}
			>
				<h3 style={{ margin: "0", "font-size": "1.1rem" }}>
					History: {noteTitle()}
				</h3>
				<A
					href={`/nooks/${encodeURIComponent(nookId())}/notes/${encodeURIComponent(noteId())}`}
					style={{ "text-decoration": "none" }}
				>
					<Button variant="secondary" size="small">
						Back to note
					</Button>
				</A>
			</div>
			<div style={{ "font-size": "0.75rem", "margin-bottom": "1rem" }}>
				<A
					href={`/nooks/${encodeURIComponent(nookId())}/settings/activity`}
					style={{
						color: "var(--link-color, #0066cc)",
						"text-decoration": "none",
					}}
				>
					View nook-wide activity
				</A>
			</div>

			<Show
				when={props.store.noteHistory().length > 0}
				fallback={
					<div style={{ color: "var(--color-text-muted, #888)" }}>
						No history yet
					</div>
				}
			>
				<NoteActivityFeed
					entries={props.store.noteHistory()}
					buildNoteHref={(id) =>
						`/nooks/${encodeURIComponent(nookId())}/notes/${encodeURIComponent(id)}`
					}
					onViewVersion={(version) => {
						if (nookId() && noteId()) {
							navigate(
								`/nooks/${encodeURIComponent(nookId())}/notes/${encodeURIComponent(noteId())}/v/${version}`,
							);
						}
					}}
					onNoteHover={(id, x, y) => {
						notePreview?.show(id, x, y, {
							onOpen: (nid) => void props.store.onNoteLinkClick(nid),
						});
					}}
					onNoteLeave={() => notePreview?.hide()}
				/>
			</Show>
		</div>
	);
}
