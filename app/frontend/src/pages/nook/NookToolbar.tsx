import { createMemo, createSignal, Show } from "solid-js";
import { Button } from "../../components/Button";
import { NoteSearchSelect } from "../../components/NoteSearchSelect";
import type { NoteSummary, NoteType } from "./types";

export type NookToolbarProps = {
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
	const [mentionTypeFilterId, setMentionTypeFilterId] =
		createSignal<string>("");

	const mentionOptions = createMemo(() => {
		return props.notes
			.filter((n) => n.id !== props.selectedId)
			.map((n) => ({
				id: n.id,
				title: n.title,
				subtitle:
					n.type === "file" ? "File" : n.type === "person" ? "Person" : "Note",
				typeId: n.typeId,
			}));
	});

	const typeNodes = createMemo(() =>
		(props.noteTypes ?? []).map((t) => ({ id: t.id, parentId: t.parentId })),
	);

	const mentionTypeOptions = createMemo(() => {
		return (props.noteTypes ?? []).map((t) => ({ id: t.id, label: t.label }));
	});

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
					<NoteSearchSelect
						value={props.mentionTargetId}
						options={mentionOptions()}
						onChange={(id) => props.onChangeMentionTargetId(id)}
						typeNodes={typeNodes()}
						typeFilter={{
							value: mentionTypeFilterId(),
							onChange: (next) => setMentionTypeFilterId(next),
							options: mentionTypeOptions(),
							placeholder: "All types",
							disabled: props.loading,
						}}
						filters={{ typeId: mentionTypeFilterId(), includeSubtypes: true }}
						placeholder="Mention note…"
						disabled={props.loading || props.notes.length === 0}
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
