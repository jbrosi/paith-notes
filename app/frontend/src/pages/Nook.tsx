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
					onQuickUploadFile={(f) => void store.quickUploadFile(f)}
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
								Type
								<select
									value={store.type()}
									onChange={(e) => {
										if (store.selectedId() !== "" && store.type() === "file") {
											return;
										}

										const next =
											e.currentTarget.value === "person"
												? "person"
												: e.currentTarget.value === "file"
													? "file"
													: "anything";

										if (store.selectedId() !== "" && next === "file") {
											return;
										}

										store.setType(next);
									}}
									disabled={
										store.mode() !== "edit" ||
										(store.selectedId() !== "" && store.type() === "file")
									}
									style={{
										width: "100%",
										padding: "8px",
										"box-sizing": "border-box",
									}}
								>
									<option value="anything">Anything</option>
									<option value="person">Person</option>
									<option
										value="file"
										disabled={
											store.selectedId() !== "" && store.type() !== "file"
										}
									>
										File
									</option>
								</select>
							</label>
						</div>

						<Show when={store.type() === "person"}>
							<div style={{ "margin-bottom": "0.5rem" }}>
								<label>
									First name
									<input
										type="text"
										value={store.personFirstName()}
										onInput={(e) =>
											store.setPersonFirstName(e.currentTarget.value)
										}
										readOnly={store.mode() !== "edit"}
										style={{
											width: "100%",
											padding: "8px",
											"box-sizing": "border-box",
										}}
									/>
								</label>
							</div>

							<div style={{ "margin-bottom": "0.5rem" }}>
								<label>
									Last name
									<input
										type="text"
										value={store.personLastName()}
										onInput={(e) =>
											store.setPersonLastName(e.currentTarget.value)
										}
										readOnly={store.mode() !== "edit"}
										style={{
											width: "100%",
											padding: "8px",
											"box-sizing": "border-box",
										}}
									/>
								</label>
							</div>

							<div style={{ "margin-bottom": "0.5rem" }}>
								<label>
									Date of birth
									<input
										type="text"
										value={store.personDateOfBirth()}
										onInput={(e) =>
											store.setPersonDateOfBirth(e.currentTarget.value)
										}
										readOnly={store.mode() !== "edit"}
										style={{
											width: "100%",
											padding: "8px",
											"box-sizing": "border-box",
										}}
									/>
								</label>
							</div>
						</Show>

						<Show when={store.type() === "file"}>
							<div
								style={{
									display: "flex",
									gap: "8px",
									"align-items": "center",
								}}
							>
								<Show when={store.fileFilename() === ""}>
									<input
										type="file"
										disabled={store.mode() !== "edit"}
										onChange={(e) => {
											const f = e.currentTarget.files?.[0];
											if (f) void store.uploadFile(f);
										}}
									/>
								</Show>
								<button
									type="button"
									onClick={() => void store.downloadFile()}
									disabled={
										store.selectedId() === "" || store.fileFilename() === ""
									}
								>
									Download
								</button>
							</div>

							<Show
								when={
									store.fileFilename() !== "" &&
									!store.fileUploadInProgress() &&
									store.fileInlineUrl() !== ""
								}
							>
								<div style={{ "margin-top": "0.5rem" }}>
									<Show when={store.fileMimeType().startsWith("image/")}>
										<img
											src={store.fileInlineUrl()}
											alt={store.fileFilename()}
											style={{
												"max-width": "100%",
												"max-height": "420px",
												border: "1px solid #eee",
												"border-radius": "8px",
											}}
										/>
									</Show>
									<Show when={store.fileMimeType() === "application/pdf"}>
										<iframe
											src={store.fileInlineUrl()}
											title={store.fileFilename()}
											style={{
												width: "100%",
												height: "520px",
												border: "1px solid #eee",
												"border-radius": "8px",
											}}
										/>
									</Show>
									<Show
										when={
											!store.fileMimeType().startsWith("image/") &&
											store.fileMimeType() !== "application/pdf"
										}
									>
										<div style={{ color: "#666" }}>
											Preview not available for this file type.
										</div>
									</Show>
								</div>
							</Show>
						</Show>

						<Show
							when={
								store.type() !== "file" ||
								(store.fileFilename() !== "" && !store.fileUploadInProgress())
							}
						>
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
						</Show>
						<Show
							when={
								store.type() !== "file" ||
								(store.fileFilename() !== "" && !store.fileUploadInProgress())
							}
						>
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
						</Show>
					</div>

					<NookMentionsPanel
						notes={store.notes()}
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
