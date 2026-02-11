import { For, Show } from "solid-js";
import type { Mention } from "./types";

export type NookMentionsPanelProps = {
	outgoing: Mention[];
	incoming: Mention[];
	onOpenNote: (noteId: string) => void;
};

export function NookMentionsPanel(props: NookMentionsPanelProps) {
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
									onClick={() => props.onOpenNote(m.note_id)}
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
										{m.link_title || m.note_title}
									</div>
									<div style={{ color: "#666" }}>{m.note_title}</div>
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
									onClick={() => props.onOpenNote(m.note_id)}
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
									<div style={{ "font-weight": "600" }}>{m.note_title}</div>
									<div style={{ color: "#666" }}>{m.link_title}</div>
								</button>
							)}
						</For>
					</Show>
				</div>
			</div>
		</div>
	);
}
