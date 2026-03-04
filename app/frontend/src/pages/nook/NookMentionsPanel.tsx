import { For, Show } from "solid-js";
import type { Mention, NoteSummary } from "./types";

export type NookMentionsPanelProps = {
	notes: NoteSummary[];
	outgoing: Mention[];
	incoming: Mention[];
	onOpenNote: (noteId: string) => void;
};

export function NookMentionsPanel(props: NookMentionsPanelProps) {
	const noteTypeLabel = (noteId: string) => {
		const t = props.notes.find((n) => n.id === noteId)?.type;
		return t === "person" ? "Person" : t === "file" ? "File" : "Note";
	};

	return (
		<div style={{ "margin-top": "1rem" }}>
			<div style={{ "font-weight": "600", "margin-bottom": "6px" }}>
				Mentions
			</div>
			<div style={{ display: "flex", gap: "16px" }}>
				<div style={{ flex: "1", "min-width": "0" }}>
					<div style={{ color: "#666", "margin-bottom": "6px" }}>Outgoing</div>
					<Show
						when={props.outgoing.length > 0}
						fallback={<div style={{ color: "#999" }}>None</div>}
					>
						<For each={props.outgoing}>
							{(m) => (
								<button
									type="button"
									onClick={() => props.onOpenNote(m.noteId)}
									style={{
										width: "100%",
										padding: "6px 8px",
										"text-align": "left",
										border: "1px solid #ddd",
										"border-radius": "6px",
										background: "white",
										cursor: "pointer",
										"margin-bottom": "6px",
									}}
								>
									<div style={{ "font-weight": "600" }}>
										{m.linkTitle || m.noteTitle}
									</div>
									<div
										style={{
											display: "flex",
											gap: "8px",
											"align-items": "center",
										}}
									>
										<div style={{ color: "#666" }}>{m.noteTitle}</div>
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
											{noteTypeLabel(m.noteId)}
										</span>
									</div>
								</button>
							)}
						</For>
					</Show>
				</div>
				<div style={{ flex: "1", "min-width": "0" }}>
					<div style={{ color: "#666", "margin-bottom": "6px" }}>Incoming</div>
					<Show
						when={props.incoming.length > 0}
						fallback={<div style={{ color: "#999" }}>None</div>}
					>
						<For each={props.incoming}>
							{(m) => (
								<button
									type="button"
									onClick={() => props.onOpenNote(m.noteId)}
									style={{
										width: "100%",
										padding: "6px 8px",
										"text-align": "left",
										border: "1px solid #ddd",
										"border-radius": "6px",
										background: "white",
										cursor: "pointer",
										"margin-bottom": "6px",
									}}
								>
									<div
										style={{
											display: "flex",
											gap: "8px",
											"align-items": "center",
										}}
									>
										<div style={{ "font-weight": "600" }}>{m.noteTitle}</div>
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
											{noteTypeLabel(m.noteId)}
										</span>
									</div>
									<div style={{ color: "#666" }}>{m.linkTitle}</div>
								</button>
							)}
						</For>
					</Show>
				</div>
			</div>
		</div>
	);
}
