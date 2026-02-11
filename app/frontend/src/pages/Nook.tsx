import { useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import styles from "../App.module.css";
import { apiFetch } from "../auth/keycloak";
import { Button } from "../components/Button";
import { MilkdownEditor } from "../components/MilkdownEditor";
import notesStyles from "./Notes.module.css";

type Note = {
	id: string;
	title: string;
	content: string;
	created_at?: string;
};

type NotesListResponse = {
	notes: Note[];
};

type NoteResponse = {
	note: Note;
};

export default function Nook() {
	const params = useParams();
	const nookId = createMemo(() => String(params.nookId ?? ""));

	const [notes, setNotes] = createSignal<Note[]>([]);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [title, setTitle] = createSignal<string>("");
	const [content, setContent] = createSignal<string>("");
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");

	const isEditing = () => mode() === "edit";

	const loadNotes = async () => {
		if (nookId() === "") {
			return;
		}

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/notes`, {
				method: "GET",
			});
			if (!res.ok) {
				throw new Error(
					`Failed to load notes: ${res.status} ${res.statusText}`,
				);
			}

			const body = (await res.json()) as NotesListResponse;
			setNotes(Array.isArray(body?.notes) ? body.notes : []);

			const currentSelected = selectedId();
			if (currentSelected === "" && (body?.notes?.length ?? 0) > 0) {
				const first = body.notes[0];
				if (first?.id) {
					setSelectedId(first.id);
					setTitle(first.title ?? "");
					setContent(first.content ?? "");
				}
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const deleteNote = async () => {
		const id = selectedId();
		if (id === "") {
			return;
		}
		if (!window.confirm(`Delete this note?`)) {
			return;
		}

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/notes/${id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				throw new Error(
					`Failed to delete note: ${res.status} ${res.statusText}`,
				);
			}

			const nextNotes = notes().filter((n) => n.id !== id);
			setNotes(nextNotes);

			if (nextNotes.length > 0) {
				selectNote(nextNotes[0]);
			} else {
				setSelectedId("");
				setTitle("");
				setContent("");
				setMode("view");
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	createEffect(() => {
		void nookId();
		void loadNotes();
	});

	const newNote = () => {
		setSelectedId("");
		setTitle("");
		setContent("");
		setError("");
		setMode("edit");
	};

	const selectNote = (note: Note) => {
		setSelectedId(note.id);
		setTitle(note.title);
		setContent(note.content);
		setError("");
	};

	const saveNote = async () => {
		if (!isEditing()) {
			return;
		}
		const t = title().trim();
		if (t === "") {
			setError("Title is required");
			return;
		}

		setLoading(true);
		setError("");
		try {
			const id = selectedId();
			if (id === "") {
				const res = await apiFetch(`/api/nooks/${nookId()}/notes`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ title: t, content: content() }),
				});
				if (!res.ok) {
					throw new Error(
						`Failed to create note: ${res.status} ${res.statusText}`,
					);
				}

				const body = (await res.json()) as NoteResponse;
				if (!body?.note?.id) {
					throw new Error("Note creation response is missing id");
				}

				setNotes([body.note, ...notes()]);
				selectNote(body.note);
			} else {
				const res = await apiFetch(`/api/nooks/${nookId()}/notes/${id}`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ title: t, content: content() }),
				});
				if (!res.ok) {
					throw new Error(
						`Failed to update note: ${res.status} ${res.statusText}`,
					);
				}

				const body = (await res.json()) as NoteResponse;
				if (!body?.note?.id) {
					throw new Error("Note update response is missing id");
				}

				setNotes(notes().map((n) => (n.id === body.note.id ? body.note : n)));
				selectNote(body.note);
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

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
						<Button onClick={newNote} variant="secondary">
							New
						</Button>
					</div>

					<div>
						<For each={notes()}>
							{(note) => (
								<button
									type="button"
									onClick={() => selectNote(note)}
									style={{
										width: "100%",
										padding: "8px",
										"text-align": "left",
										"border-radius": "6px",
										border: "1px solid #ddd",
										background: note.id === selectedId() ? "#f6f8fa" : "white",
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

				<div style={{ flex: "1", "min-width": "0" }}>
					<div
						class={notesStyles["add-note-container"]}
						style={{
							display: "flex",
							gap: "8px",
							"align-items": "center",
						}}
					>
						<Button
							onClick={() => setMode((m) => (m === "edit" ? "view" : "edit"))}
							variant="secondary"
						>
							Switch to {isEditing() ? "View" : "Edit"}
						</Button>
						<div style={{ color: "#666" }}>Mode: {mode()}</div>
						<div style={{ flex: "1" }} />
						<Button
							onClick={loadNotes}
							variant="secondary"
							disabled={loading()}
						>
							Refresh
						</Button>
						<Button
							onClick={saveNote}
							disabled={loading() || !isEditing() || title().trim() === ""}
						>
							Save
						</Button>
						<Button
							onClick={deleteNote}
							variant="danger"
							disabled={loading() || selectedId() === ""}
						>
							Delete
						</Button>
					</div>

					<div style={{ "margin-bottom": "1rem" }}>
						<div style={{ "margin-bottom": "0.5rem" }}>
							<label>
								Title
								<input
									type="text"
									value={title()}
									onInput={(e) => setTitle(e.currentTarget.value)}
									readOnly={!isEditing()}
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
									value={content()}
									onChange={setContent}
									readonly={!isEditing()}
								/>
							</div>
						</div>
					</div>

					<Show when={error() !== ""}>
						<pre class={styles.error}>{error()}</pre>
					</Show>
				</div>
			</div>
		</main>
	);
}
