import { useParams } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import styles from "../App.module.css";
import { MilkdownEditor } from "../components/MilkdownEditor";
import notesStyles from "./Notes.module.css";
import { NookMentionsPanel } from "./nook/NookMentionsPanel";
import { NookSidebar } from "./nook/NookSidebar";
import { NookToolbar } from "./nook/NookToolbar";
import { createNookStore } from "./nook/store";

export default function Nook() {
	const params = useParams();
	const nookId = createMemo(() => String(params.nookId ?? ""));
	const store = createNookStore(nookId);

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>My Notes</h1>
			<p class={styles.subtitle}>Manage your notes here</p>

			{nookId() !== "" ? (
				<p class={styles.subtitle}>
					Nook: <code>{nookId()}</code>
				</p>
			) : null}

			<div style={{ display: "flex", gap: "16px", "align-items": "stretch" }}>
				<NookSidebar
					notes={store.notes()}
					selectedId={store.selectedId()}
					onNew={store.newNote}
					onSelect={store.selectNote}
				/>

				<div style={{ flex: "1", "min-width": "0" }}>
					<div class={notesStyles["add-note-container"]}>
						<NookToolbar
							mode={store.mode()}
							loading={store.loading()}
							title={store.title()}
							selectedId={store.selectedId()}
							notes={store.notes()}
							mentionTargetId={store.mentionTargetId()}
							onToggleMode={() =>
								store.setMode((m) => (m === "edit" ? "view" : "edit"))
							}
							onRefresh={store.loadNotes}
							onChangeMentionTargetId={store.setMentionTargetId}
							onInsertMention={store.insertMention}
							onSave={store.saveNote}
							onDelete={store.deleteNote}
						/>
					</div>

					<div style={{ "margin-bottom": "1rem" }}>
						<div style={{ "margin-bottom": "0.5rem" }}>
							<label>
								Title
								<input
									type="text"
									value={store.title()}
									onInput={(e) => store.setTitle(e.currentTarget.value)}
									readOnly={store.mode() !== "edit"}
									style={{
										width: "100%",
										padding: "8px",
										"box-sizing": "border-box",
									}}
								/>
							</label>
						</div>
						<div>
							<div style={{ "margin-bottom": "0.5rem" }}>Content</div>
							<div
								style={{
									border: "1px solid #ccc",
									"border-radius": "8px",
									overflow: "hidden",
								}}
							>
								<MilkdownEditor
									value={store.content()}
									onChange={store.setContent}
									readonly={store.mode() !== "edit"}
									onNoteLinkClick={(id) => void store.onNoteLinkClick(id)}
								/>
							</div>
						</div>
					</div>

					<NookMentionsPanel
						outgoing={store.outgoingMentions()}
						incoming={store.incomingMentions()}
						onOpenNote={(id) => void store.onNoteLinkClick(id)}
					/>

					<Show when={store.error() !== ""}>
						<pre class={styles.error}>{store.error()}</pre>
					</Show>
				</div>
			</div>
		</main>
	);
}
