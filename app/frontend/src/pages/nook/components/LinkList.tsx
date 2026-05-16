import { For, Show } from "solid-js";
import type { PreviewAction } from "../../../components/NotePreview";
import { useNotePreview } from "../NookContext";
import css from "../NookNoteLinksPanel.module.css";
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
									const rect = (
										e.currentTarget as HTMLElement
									).getBoundingClientRect();
									const actions: PreviewAction[] = [];
									if (props.isEditing) {
										actions.push({
											label: "Remove link",
											danger: true,
											onClick: () => props.onDeleteLink(l.id),
										});
									}
									notePreview?.show(otherId, rect.left, rect.bottom, {
										immediate: true,
										onOpen: (id) => props.onOpenNote(id),
										actions,
									});
								}}
								onMouseEnter={(e) => {
									const rect = (
										e.currentTarget as HTMLElement
									).getBoundingClientRect();
									notePreview?.show(otherId, rect.left, rect.bottom, {
										onOpen: (id) => props.onOpenNote(id),
									});
								}}
								onMouseLeave={() => notePreview?.hide()}
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
