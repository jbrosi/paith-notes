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
	mentionEmbedImage: boolean;
	onToggleMode: () => void;
	onRefresh: () => void;
	onChangeMentionTargetId: (id: string) => void;
	onChangeMentionEmbedImage: (next: boolean) => void;
	onInsertMention: () => void;
	onSave: () => void;
	onDelete: () => void;
};

export function NookToolbar(props: NookToolbarProps) {
	const isEditing = () => props.mode === "edit";
	const canEmbedImage = () => {
		const id = props.mentionTargetId;
		if (id === "") return false;
		const n = props.notes.find((x) => x.id === id);
		if (!n) return false;
		if (n.type !== "file") return false;
		return String(n.properties?.mime_type ?? "").startsWith("image/");
	};

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
			<label style={{ display: "flex", gap: "6px", "align-items": "center" }}>
				<input
					type="checkbox"
					checked={props.mentionEmbedImage}
					onChange={(e) =>
						props.onChangeMentionEmbedImage(e.currentTarget.checked)
					}
					disabled={props.loading || !isEditing() || !canEmbedImage()}
				/>
				Include image
			</label>
			<Button
				onClick={props.onInsertMention}
				variant="secondary"
				disabled={props.loading || !isEditing() || props.mentionTargetId === ""}
			>
				Insert
			</Button>
			<Button
				onClick={props.onSave}
				disabled={props.loading || !isEditing() || props.title.trim() === ""}
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
		</div>
	);
}
