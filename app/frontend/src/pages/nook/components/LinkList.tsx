import { For, Show } from "solid-js";
import { ActorLabel } from "../../../components/ActorLabel";
import { TimeAgo } from "../../../components/TimeAgo";
import { useNotePreview } from "../NookContext";
import type { NoteLink } from "../types";

type Props = {
	links: NoteLink[];
	noteId: string;
	isEditing: boolean;
	onOpenNote: (id: string) => void;
	onDeleteLink: (linkId: string) => void;
};

export function LinkList(props: Props) {
	const notePreview = useNotePreview();
	const otherNoteId = (l: NoteLink) =>
		l.sourceNoteId === props.noteId ? l.targetNoteId : l.sourceNoteId;

	const directionLabel = (l: NoteLink) =>
		l.sourceNoteId === props.noteId ? l.forwardLabel : l.reverseLabel;

	const titleForLink = (l: NoteLink, id: string) => {
		if (l.sourceNoteId === id)
			return l.sourceNoteTitle?.trim() ? l.sourceNoteTitle : id;
		if (l.targetNoteId === id)
			return l.targetNoteTitle?.trim() ? l.targetNoteTitle : id;
		return id;
	};

	return (
		<Show
			when={props.links.length > 0}
			fallback={
				<div style={{ color: "var(--color-text-faint)", "font-size": "0.8rem" }}>
					No links yet
				</div>
			}
		>
			<div>
				<For each={props.links}>
					{(l) => {
						const otherId = otherNoteId(l);
						return (
							<div style={{
								padding: "4px 0",
								"font-size": "0.8rem",
								display: "flex",
								"align-items": "baseline",
								gap: "4px",
								"flex-wrap": "wrap",
							}}>
								<span style={{ color: "var(--color-text-muted)" }}>
									{directionLabel(l)}
								</span>
								<span
									style={{
										color: "var(--link-color, #0066cc)",
										cursor: "pointer",
										"font-weight": "500",
									}}
									onClick={() => props.onOpenNote(otherId)}
									onMouseEnter={(e) => {
										const rect = e.currentTarget.getBoundingClientRect();
										notePreview?.show(otherId, rect.left, rect.bottom, {
											onOpen: (id) => props.onOpenNote(id),
										});
									}}
									onMouseLeave={() => notePreview?.hide()}
								>
									{titleForLink(l, otherId)}
								</span>
								<Show when={l.startDate !== "" || l.endDate !== ""}>
									<span style={{ color: "var(--color-text-faint)", "font-size": "0.7rem" }}>
										{l.startDate || "?"} → {l.endDate || "?"}
									</span>
								</Show>
								<Show when={l.lastUserName || l.lastActor === "ai"}>
									<span style={{ "font-size": "0.65rem", color: "var(--color-text-muted)" }}>
										<ActorLabel actor={l.lastActor} userName={l.lastUserName} />
									</span>
								</Show>
								<Show when={l.createdAt}>
									<span style={{ "font-size": "0.65rem" }}>
										<TimeAgo date={l.createdAt ?? ""} />
									</span>
								</Show>
								<Show when={props.isEditing}>
									<button
										type="button"
										onClick={() => {
											if (window.confirm("Remove this link?")) {
												props.onDeleteLink(l.id);
											}
										}}
										style={{
											background: "none",
											border: "none",
											color: "var(--color-danger, #dc2626)",
											cursor: "pointer",
											"font-size": "0.7rem",
											padding: "0 2px",
										}}
										title="Remove link"
									>
										&times;
									</button>
								</Show>
							</div>
						);
					}}
				</For>
			</div>
		</Show>
	);
}
