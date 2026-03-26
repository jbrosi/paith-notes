import { Show } from "solid-js";
import { Button } from "../../components/Button";

export type NookToolbarProps = {
	mode: "view" | "edit";
	loading: boolean;
	title: string;
	selectedId: string;
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
			<div style={{ flex: "1" }} />
			<Show when={isEditing()}>
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
