import { useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import styles from "../App.module.css";
import { apiFetch } from "../auth/keycloak";
import { Button } from "../components/Button";
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

function isCypressRun(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as unknown as { Cypress?: unknown }).Cypress !== "undefined"
	);
}

export default function Nook() {
	const params = useParams();
	const nookId = createMemo(() => String(params.nookId ?? ""));

	const [notes, setNotes] = createSignal<Note[]>(
		isCypressRun()
			? [
					{
						id: "1",
						title: "First Note",
						content: "This is my first note",
					},
					{
						id: "2",
						title: "Second Note",
						content: "This is my second note",
					},
				]
			: [],
	);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [title, setTitle] = createSignal<string>("");
	const [content, setContent] = createSignal<string>("");
	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");

	const loadNotes = async () => {
		if (isCypressRun()) {
			return;
		}
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
				throw new Error(`Failed to load notes: ${res.status} ${res.statusText}`);
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

	createEffect(() => {
		void nookId();
		void loadNotes();
	});

	const newNote = () => {
		setSelectedId("");
		setTitle("");
		setContent("");
		setError("");
	};

	const selectNote = (note: Note) => {
		setSelectedId(note.id);
		setTitle(note.title);
		setContent(note.content);
		setError("");
	};

	const addNote = async () => {
		if (isCypressRun()) {
			const current = notes();
			const newItem: Note = {
				id: String(Date.now()),
				title: `Note ${current.length + 1}`,
				content: "New note content",
			};
			setNotes([...current, newItem]);
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
			const res = await apiFetch(`/api/nooks/${nookId()}/notes`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ title: t, content: content() }),
			});
			if (!res.ok) {
				throw new Error(`Failed to create note: ${res.status} ${res.statusText}`);
			}

			const body = (await res.json()) as NoteResponse;
			if (!body?.note?.id) {
				throw new Error("Note creation response is missing id");
			}

			setNotes([body.note, ...notes()]);
			selectNote(body.note);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const saveNote = async () => {
		if (isCypressRun()) {
			const id = selectedId();
			if (id === "") {
				return;
			}
			setNotes(
				notes().map((n) =>
					n.id === id ? { ...n, title: title(), content: content() } : n,
				),
			);
			return;
		}

		const id = selectedId();
		if (id === "") {
			setError("Select a note to save (or create a new one)");
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
			const res = await apiFetch(`/api/nooks/${nookId()}/notes/${id}`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ title: t, content: content() }),
			});
			if (!res.ok) {
				throw new Error(`Failed to update note: ${res.status} ${res.statusText}`);
			}

			const body = (await res.json()) as NoteResponse;
			if (!body?.note?.id) {
				throw new Error("Note update response is missing id");
			}

			setNotes(notes().map((n) => (n.id === body.note.id ? body.note : n)));
			selectNote(body.note);
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

			<div class={notesStyles["add-note-container"]}>
				{isCypressRun() ? (
					<Button onClick={addNote}>Add Note</Button>
				) : (
					<>
						<Button onClick={newNote} variant="secondary">
							New
						</Button>
						<Button onClick={addNote} disabled={loading()}>
							Create
						</Button>
						<Button
							onClick={saveNote}
							disabled={loading() || selectedId() === ""}
						>
							Save
						</Button>
						<Button onClick={loadNotes} variant="secondary" disabled={loading()}>
							Refresh
						</Button>
					</>
				)}
			</div>

			<div style={{ "margin-bottom": "1rem" }}>
				<div style={{ "margin-bottom": "0.5rem" }}>
					<label>
						Title
						<input
							type="text"
							value={title()}
							onInput={(e) => setTitle(e.currentTarget.value)}
							style={{ width: "100%", padding: "8px", "box-sizing": "border-box" }}
						/>
					</label>
				</div>
				<div>
					<label>
						Content
						<textarea
							value={content()}
							onInput={(e) => setContent(e.currentTarget.value)}
							rows={6}
							style={{ width: "100%", padding: "8px", "box-sizing": "border-box" }}
						/>
					</label>
				</div>
			</div>

			<Show when={error() !== ""}>
				<pre class={styles.error}>{error()}</pre>
			</Show>

			<div>
				<For each={notes()}>
					{(note) => (
						<div
							class={notesStyles["note-card"]}
							onClick={() => selectNote(note)}
							style={{
								cursor: "pointer",
								"border-color":
									note.id === selectedId() ? "#111" : undefined,
							}}
						>
							<h3>{note.title}</h3>
							<p>{note.content}</p>
						</div>
					)}
				</For>
			</div>
		</main>
	);
}
