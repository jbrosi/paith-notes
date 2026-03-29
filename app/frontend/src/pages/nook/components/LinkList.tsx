import { For, Show } from "solid-js";
import type { PreviewAction } from "../../../components/NotePreview";
import type { NotePreviewController } from "../NookDefaultLayout";
import css from "../NookNoteLinksPanel.module.css";
import type { NoteLink } from "../types";

type Props = {
	links: NoteLink[];
	noteId: string;
	isEditing: boolean;
	notePreview?: NotePreviewController;
	onOpenNote: (id: string) => void;
	onDeleteLink: (linkId: string) => void;
};

export function LinkList(props: Props) {
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
		<div>
			<div class={css.sectionTitle}>Existing links</div>
			<Show
				when={props.links.length > 0}
				fallback={<div class={css.emptyText}>(none)</div>}
			>
				<For each={props.links}>
					{(l) => {
						const otherId = otherNoteId(l);
						return (
							<button
								type="button"
								onClick={(e) => {
									const actions: PreviewAction[] = [];
									if (props.isEditing) {
										actions.push({
											label: "Remove link",
											danger: true,
											onClick: () => props.onDeleteLink(l.id),
										});
									}
									props.notePreview?.show(otherId, e.clientX, e.clientY, {
										immediate: true,
										onOpen: (id) => props.onOpenNote(id),
										actions,
									});
								}}
								onMouseEnter={(e) =>
									props.notePreview?.show(otherId, e.clientX, e.clientY, {
										onOpen: (id) => props.onOpenNote(id),
									})
								}
								onMouseLeave={() => props.notePreview?.hide()}
								class={css.linkBtn}
							>
								<div class={css.linkContent}>
									<div>
										<strong>{directionLabel(l)}</strong>{" "}
										{titleForLink(l, otherId)}
									</div>
									<Show when={l.startDate !== "" || l.endDate !== ""}>
										<div class={css.linkDates}>
											{l.startDate || "(no start)"} → {l.endDate || "(no end)"}
										</div>
									</Show>
								</div>
							</button>
						);
					}}
				</For>
			</Show>
		</div>
	);
}
