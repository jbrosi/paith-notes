import { For } from "solid-js";
import { Button } from "../../components/Button";
import type { Note } from "./types";

export type NookSidebarProps = {
	notes: Note[];
	selectedId: string;
	onNew: () => void;
	onSelect: (note: Note) => void;
};

export function NookSidebar(props: NookSidebarProps) {
	return (
		<div
			style={{
				width: "260px",
				"flex-shrink": "0",
				"border-right": "1px solid #eee",
				padding: "0 16px 0 0",
			}}
		>
			<div
				style={{
					display: "flex",
					"justify-content": "space-between",
					"align-items": "center",
					"margin-bottom": "12px",
				}}
			>
				<div style={{ "font-weight": "600" }}>Notes</div>
				<Button onClick={props.onNew} variant="secondary">
					New
				</Button>
			</div>

			<div>
				<For each={props.notes}>
					{(note) => (
						<button
							type="button"
							onClick={() => props.onSelect(note)}
							style={{
								width: "100%",
								padding: "8px",
								"text-align": "left",
								"border-radius": "6px",
								border: "1px solid #ddd",
								background: note.id === props.selectedId ? "#f6f8fa" : "white",
								"margin-bottom": "8px",
								cursor: "pointer",
							}}
						>
							<div style={{ "font-weight": "600" }}>{note.title}</div>
						</button>
					)}
				</For>
			</div>
		</div>
	);
}
