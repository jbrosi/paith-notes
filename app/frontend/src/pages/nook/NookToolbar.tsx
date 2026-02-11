import { For } from "solid-js";
import { Button } from "../../components/Button";
import type { Note } from "./types";

export type NookToolbarProps = {
	mode: "view" | "edit";
	loading: boolean;
	title: string;
	selectedId: string;
	notes: Note[];
	mentionTargetId: string;
	onToggleMode: () => void;
	onRefresh: () => void;
	onChangeMentionTargetId: (id: string) => void;
	onInsertMention: () => void;
	onSave: () => void;
	onDelete: () => void;
};

export function NookToolbar(props: NookToolbarProps) {
	const isEditing = () => props.mode === "edit";

	return (
		<div
			style={{
				display: "flex",
				gap: "8px",
				"align-items": "center",
			}}
		>
			<Button onClick={props.onToggleMode} variant="secondary">
				Switch to {isEditing() ? "View" : "Edit"}
			</Button>
			<div style={{ color: "#666" }}>Mode: {props.mode}</div>
			<div style={{ flex: "1" }} />
			<Button
				onClick={props.onRefresh}
				variant="secondary"
				disabled={props.loading}
			>
				Refresh
			</Button>
			<select
				value={props.mentionTargetId}
				onChange={(e) => props.onChangeMentionTargetId(e.currentTarget.value)}
				disabled={props.loading || props.notes.length === 0}
				style={{
					"max-width": "220px",
					padding: "6px",
				}}
			>
				<option value="">Mention note…</option>
				<For each={props.notes.filter((n) => n.id !== props.selectedId)}>
					{(n) => <option value={n.id}>{n.title}</option>}
				</For>
			</select>
			<Button
				onClick={props.onInsertMention}
				variant="secondary"
				disabled={props.loading || !isEditing() || props.mentionTargetId === ""}
			>
				Insert
			</Button>
			<Button onClick={props.onSave} disabled={props.loading || !isEditing() || props.title.trim() === ""}>
				Save
			</Button>
			<Button
				onClick={props.onDelete}
				variant="danger"
				disabled={props.loading || props.selectedId === ""}
			>
				Delete
			</Button>
		</div>
	);
}
