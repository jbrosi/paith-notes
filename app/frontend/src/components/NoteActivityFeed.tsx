import { For, Show } from "solid-js";
import type { NoteHistoryEntry } from "../pages/nook/types";
import { ActivityEntryRow } from "./ActivityEntryRow";

type Props = {
	entries: NoteHistoryEntry[];
	/** Build href for a note ID */
	buildNoteHref: (noteId: string) => string;
	/** Called when version badge is clicked */
	onViewVersion?: (version: number) => void;
	/** Called on hover over linked note (for preview) */
	onNoteHover?: (noteId: string, x: number, y: number) => void;
	/** Called on mouse leave from linked note */
	onNoteLeave?: () => void;
};

/**
 * Pure rendering component for a note's activity feed.
 * Handles both note edits and link changes.
 */
export function NoteActivityFeed(props: Props) {
	return (
		<Show when={props.entries.length > 0}>
			<div
				id="note-history-section"
				style={{
					"padding-top": "0.75rem",
					"border-top": "1px solid var(--color-border-light, #eee)",
					"margin-top": "1rem",
				}}
			>
				<For each={props.entries}>
					{(entry) => (
						<ActivityEntryRow
							entry={{
								actor: entry.actor,
								userName: entry.userName,
								action: entry.action,
								type: entry.type,
								...(entry.type === "link"
									? {
											linkSourceTitle: "this note",
											linkLabel: entry.linkLabel || "→",
											linkTargetTitle: entry.linkedNoteTitle || undefined,
											linkTargetId: entry.linkedNoteId || undefined,
										}
									: {
											version: entry.version,
										}),
								createdAt: entry.createdAt,
							}}
							onViewVersion={props.onViewVersion}
							buildNoteHref={props.buildNoteHref}
							onNoteHover={props.onNoteHover}
							onNoteLeave={props.onNoteLeave}
						/>
					)}
				</For>
			</div>
		</Show>
	);
}
