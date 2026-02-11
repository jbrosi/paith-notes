import { For } from "solid-js";
import { Button } from "../../components/Button";
import type { Note } from "./types";

export type NookSidebarProps = {
	notes: Note[];
	selectedId: string;
	onNew: () => void;
	onSelect: (note: Note) => void;
	onQuickUploadFile: (file: File) => void;
};

export function NookSidebar(props: NookSidebarProps) {
	let quickUploadInput: HTMLInputElement | undefined;

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
				<div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
					<input
						ref={quickUploadInput}
						type="file"
						style={{ display: "none" }}
						onChange={(e) => {
							const f = e.currentTarget.files?.[0];
							e.currentTarget.value = "";
							if (f) props.onQuickUploadFile(f);
						}}
					/>
					<Button variant="secondary" onClick={() => quickUploadInput?.click()}>
						Upload file
					</Button>
					<Button onClick={props.onNew} variant="secondary">
						New
					</Button>
				</div>
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
							<div
								style={{
									display: "flex",
									gap: "8px",
									"align-items": "center",
									"justify-content": "space-between",
								}}
							>
								<div
									style={{
										display: "flex",
										gap: "8px",
										"align-items": "center",
									}}
								>
									<div style={{ "font-weight": "600" }}>{note.title}</div>
									{note.type === "person" ? (
										<span
											style={{
												"font-size": "12px",
												padding: "2px 6px",
												"border-radius": "999px",
												border: "1px solid #c9def7",
												background: "#eef5ff",
												color: "#1f5fbf",
											}}
										>
											Person
										</span>
									) : note.type === "file" ? (
										<span
											style={{
												"font-size": "12px",
												padding: "2px 6px",
												"border-radius": "999px",
												border: "1px solid #c9def7",
												background: "#eef5ff",
												color: "#1f5fbf",
											}}
										>
											File
										</span>
									) : null}
								</div>
								<div
									style={{
										display: "flex",
										gap: "6px",
										"align-items": "center",
										color: "#666",
										"font-size": "12px",
									}}
								>
									<div>in {note.incomingMentionsCount}</div>
									<div>out {note.outgoingMentionsCount}</div>
								</div>
							</div>
						</button>
					)}
				</For>
			</div>
		</div>
	);
}
