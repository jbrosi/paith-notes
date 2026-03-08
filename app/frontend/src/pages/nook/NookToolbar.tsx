import { Show } from "solid-js";
import { Button } from "../../components/Button";
import { RemoteNoteSearchSelect } from "../../components/RemoteNoteSearchSelect";
import type { NoteSummary, NoteType } from "./types";

export type NookToolbarProps = {
	nookId: string;
	mode: "view" | "edit";
	loading: boolean;
	title: string;
	selectedId: string;
	notes: NoteSummary[];
	noteTypes?: NoteType[];
	mentionTargetId: string;
	mentionEmbedImage: boolean;
	mentionCanEmbedImage: boolean;
	onRefresh: () => void;
	onChangeMentionTargetId: (id: string) => void;
	onChangeMentionEmbedImage: (next: boolean) => void;
	onInsertMention: () => void;
	onSave: () => void;
	onDelete: () => void;
};

export function NookToolbar(props: NookToolbarProps) {
	const isEditing = () => props.mode === "edit";
	const canEmbedImage = () => props.mentionCanEmbedImage;

	return (
		<div
			style={{
				display: "flex",
				gap: "8px",
				"align-items": "center",
			}}
		>
			<div style={{ flex: "1" }} />
			<Button
				onClick={props.onRefresh}
				variant="secondary"
				disabled={props.loading}
			>
				Refresh
			</Button>
			<Show when={isEditing()}>
				<div style={{ width: "220px" }}>
					<RemoteNoteSearchSelect
						value={props.mentionTargetId}
						onChange={(id) => props.onChangeMentionTargetId(id)}
						nookId={props.nookId}
						noteTypes={props.noteTypes ?? []}
						excludeIds={[props.selectedId]}
						placeholder="Mention note…"
						disabled={props.loading || props.nookId.trim() === ""}
					/>
				</div>
				<label style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<input
						type="checkbox"
						checked={props.mentionEmbedImage}
						onChange={(e) =>
							props.onChangeMentionEmbedImage(e.currentTarget.checked)
						}
						disabled={props.loading || !canEmbedImage()}
					/>
					Include image
				</label>
				<Button
					onClick={props.onInsertMention}
					variant="secondary"
					disabled={props.loading || props.mentionTargetId === ""}
				>
					Insert
				</Button>
				<Button
					onClick={props.onSave}
					disabled={props.loading || props.title.trim() === ""}
				>
					Save
				</Button>
				<Button
					onClick={props.onDelete}
					variant="danger"
					disabled={props.loading || props.selectedId === ""}
				>
					Delete
				</Button>
			</Show>
		</div>
	);
}
