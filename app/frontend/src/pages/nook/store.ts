import { createEffect, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import type { Mention, Note } from "./types";
import {
	MentionsResponseSchema,
	NoteResponseSchema,
	NotesListResponseSchema,
} from "./types";

export function createNookStore(nookId: () => string) {
	const [notes, setNotes] = createSignal<Note[]>([]);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [title, setTitle] = createSignal<string>("");
	const [content, setContent] = createSignal<string>("");
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [mentionTargetId, setMentionTargetId] = createSignal<string>("");
	const [outgoingMentions, setOutgoingMentions] = createSignal<Mention[]>([]);
	const [incomingMentions, setIncomingMentions] = createSignal<Mention[]>([]);

	const isEditing = () => mode() === "edit";

	const loadMentions = async () => {
		if (nookId() === "") return;
		const noteId = selectedId();
		if (noteId === "") {
			setOutgoingMentions([]);
			setIncomingMentions([]);
			return;
		}

		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId}/mentions`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to load mentions: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = MentionsResponseSchema.parse(json);
			setOutgoingMentions(body.outgoing);
			setIncomingMentions(body.incoming);
		} catch (e) {
			setOutgoingMentions([]);
			setIncomingMentions([]);
			setError(String(e));
		}
	};

	const loadNotes = async () => {
		if (nookId() === "") return;

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
			const json = await res.json();
			const body = NotesListResponseSchema.parse(json);
			setNotes(body.notes);

			const currentSelected = selectedId();
			if (currentSelected === "" && (body?.notes?.length ?? 0) > 0) {
				const first = body.notes[0];
				if (first?.id) {
					setSelectedId(first.id);
					setTitle(first.title ?? "");
					setContent(first.content ?? "");
					await loadMentions();
				}
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

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
		void loadMentions();
	};

	const onNoteLinkClick = async (noteId: string) => {
		let found = notes().find((n) => n.id === noteId);
		if (!found) {
			await loadNotes();
			found = notes().find((n) => n.id === noteId);
		}
		if (!found) {
			setError(`Note not found: ${noteId}`);
			return;
		}
		selectNote(found);
	};

	const insertMention = () => {
		if (!isEditing()) return;
		const targetId = mentionTargetId();
		if (targetId === "") return;
		const target = notes().find((n) => n.id === targetId);
		if (!target) return;

		const text = `[${target.title}](note:${target.id})`;
		const prefix = content() === "" ? "" : "\n\n";
		setContent(`${content()}${prefix}${text}`);
	};

	const saveNote = async () => {
		if (!isEditing()) return;
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
				const json = await res.json();
				const body = NoteResponseSchema.parse(json);

				setNotes([body.note, ...notes()]);
				selectNote(body.note);
				await loadMentions();
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
				const json = await res.json();
				const body = NoteResponseSchema.parse(json);

				setNotes(notes().map((n) => (n.id === body.note.id ? body.note : n)));
				selectNote(body.note);
				await loadMentions();
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const deleteNote = async () => {
		const id = selectedId();
		if (id === "") return;
		if (!window.confirm("Delete this note?")) return;

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
				await loadMentions();
			} else {
				setSelectedId("");
				setTitle("");
				setContent("");
				setMode("view");
				setOutgoingMentions([]);
				setIncomingMentions([]);
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

	return {
		notes,
		selectedId,
		title,
		content,
		mode,
		loading,
		error,
		mentionTargetId,
		outgoingMentions,
		incomingMentions,
		isEditing,
		setTitle,
		setContent,
		setMode,
		setMentionTargetId,
		loadNotes,
		loadMentions,
		newNote,
		selectNote,
		onNoteLinkClick,
		insertMention,
		saveNote,
		deleteNote,
	};
}
