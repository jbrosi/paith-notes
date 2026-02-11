import { createEffect, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import type { Mention, Note } from "./types";
import {
	MentionsResponseSchema,
	NoteResponseSchema,
	NotesListResponseSchema,
} from "./types";

export function createNookStore(nookId: () => string) {
	const fileInlineUrlCache = new Map<string, string>();
	const [notes, setNotes] = createSignal<Note[]>([]);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [title, setTitle] = createSignal<string>("");
	const [titleIsManual, setTitleIsManual] = createSignal<boolean>(false);
	const [content, setContent] = createSignal<string>("");
	const [type, setType] = createSignal<"anything" | "person" | "file">(
		"anything",
	);
	const [personFirstName, setPersonFirstName] = createSignal<string>("");
	const [personLastName, setPersonLastName] = createSignal<string>("");
	const [personDateOfBirth, setPersonDateOfBirth] = createSignal<string>("");
	const [fileFilename, setFileFilename] = createSignal<string>("");
	const [fileExtension, setFileExtension] = createSignal<string>("");
	const [fileFilesize, setFileFilesize] = createSignal<string>("");
	const [fileMimeType, setFileMimeType] = createSignal<string>("");
	const [fileChecksum, setFileChecksum] = createSignal<string>("");
	const [fileInlineUrl, setFileInlineUrl] = createSignal<string>("");
	const [formerProperties, setFormerProperties] = createSignal<
		Record<string, unknown>
	>({});
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [mentionTargetId, setMentionTargetId] = createSignal<string>("");
	const [mentionEmbedImage, setMentionEmbedImage] =
		createSignal<boolean>(false);
	const [outgoingMentions, setOutgoingMentions] = createSignal<Mention[]>([]);
	const [incomingMentions, setIncomingMentions] = createSignal<Mention[]>([]);
	const [fileUploadInProgress, setFileUploadInProgress] =
		createSignal<boolean>(false);

	const isEditing = () => mode() === "edit";

	const personDerivedTitle = () => {
		const first = personFirstName().trim();
		const last = personLastName().trim();
		return `${first} ${last}`.trim();
	};

	const derivedTitleFromNote = (note: Note) => {
		const first = String(note.properties?.first_name ?? "").trim();
		const last = String(note.properties?.last_name ?? "").trim();
		return `${first} ${last}`.trim();
	};

	const setTitleFromUser = (next: string) => {
		setTitle(next);
		if (type() === "person" && next.trim() === "") {
			setTitleIsManual(false);
			return;
		}
		setTitleIsManual(true);
	};

	const resolveEmbeddedImageSrc = async (noteId: string) => {
		const id = noteId.trim();
		if (id === "") return null;
		if (nookId() === "") return null;
		const cached = fileInlineUrlCache.get(id);
		if (cached) return cached;

		let n = notes().find((x) => x.id === id);
		if (!n) {
			await loadNotes();
			n = notes().find((x) => x.id === id);
		}
		if (!n) return null;
		if (n.type !== "file") return null;

		const mime = String(n.properties?.mime_type ?? "");
		if (!mime.startsWith("image/")) return null;

		const res = await apiFetch(
			`/api/nooks/${nookId()}/notes/${id}/file/download-url?inline=1`,
			{ method: "GET" },
		);
		if (!res.ok) {
			return null;
		}
		const json = (await res.json()) as unknown as { download_url?: string };
		const url = String(json?.download_url ?? "");
		if (url === "") return null;
		fileInlineUrlCache.set(id, url);
		return url;
	};

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

	const uploadEmbeddedImage = async (file: File) => {
		if (nookId() === "") return null;
		setError("");
		try {
			const filename = file.name || "embedded";
			const ext = filename.includes(".")
				? (filename.split(".").pop() ?? "")
				: "";
			const mime = file.type;

			const createRes = await apiFetch(`/api/nooks/${nookId()}/notes`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title: filename,
					content: "",
					type: "file",
					properties: {},
				}),
			});
			if (!createRes.ok) {
				throw new Error(
					`Failed to create embedded file note: ${createRes.status} ${createRes.statusText}`,
				);
			}
			const createJson = await createRes.json();
			const createBody = NoteResponseSchema.parse(createJson);
			const noteId = createBody.note.id;
			setNotes([createBody.note, ...notes()]);

			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId}/file/upload-url`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						filename,
						extension: ext,
						filesize: file.size,
						mime_type: mime,
						checksum: "",
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to get embedded upload URL: ${res.status} ${res.statusText}`,
				);
			}
			const json = (await res.json()) as unknown as { upload_url?: string };
			const uploadUrl = String(json?.upload_url ?? "");
			if (uploadUrl === "") {
				throw new Error("Upload URL missing from response");
			}

			const putRes = await fetch(uploadUrl, { method: "PUT", body: file });
			if (!putRes.ok) {
				throw new Error(
					`Embedded upload failed: ${putRes.status} ${putRes.statusText}`,
				);
			}

			setNotes(
				notes().map((n) =>
					n.id === noteId
						? {
								...n,
								properties: {
									...(typeof n.properties === "object" && n.properties
										? n.properties
										: {}),
									filename,
									extension: ext,
									filesize: file.size,
									mime_type: mime,
									checksum: "",
								},
							}
						: n,
				),
			);
			return noteId;
		} catch (e) {
			setError(String(e));
			return null;
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
					selectNote(first);
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
		setTitleIsManual(false);
		setContent("");
		setType("anything");
		setPersonFirstName("");
		setPersonLastName("");
		setPersonDateOfBirth("");
		setFileFilename("");
		setFileExtension("");
		setFileFilesize("");
		setFileMimeType("");
		setFileChecksum("");
		setFormerProperties({});
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
		setMode("edit");
	};

	const selectNote = (note: Note) => {
		setSelectedId(note.id);
		setTitle(note.title);
		setContent(note.content);
		setType(
			note.type === "person"
				? "person"
				: note.type === "file"
					? "file"
					: "anything",
		);
		setPersonFirstName(String(note.properties?.first_name ?? ""));
		setPersonLastName(String(note.properties?.last_name ?? ""));
		setPersonDateOfBirth(String(note.properties?.date_of_birth ?? ""));
		setFileFilename(String(note.properties?.filename ?? ""));
		setFileExtension(String(note.properties?.extension ?? ""));
		setFileFilesize(String(note.properties?.filesize ?? ""));
		setFileMimeType(String(note.properties?.mime_type ?? ""));
		setFileChecksum(String(note.properties?.checksum ?? ""));
		setFileInlineUrl("");
		if (note.type === "person") {
			const derived = derivedTitleFromNote(note);
			setTitleIsManual(derived === "" ? true : note.title.trim() !== derived);
		} else {
			setTitleIsManual(true);
		}
		setFormerProperties(
			(note as unknown as { formerProperties?: Record<string, unknown> })
				.formerProperties ?? {},
		);
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
		void loadMentions();
	};

	const loadFileInlineUrl = async () => {
		const id = selectedId();
		if (id === "") {
			setFileInlineUrl("");
			return;
		}
		if (type() !== "file") {
			setFileInlineUrl("");
			return;
		}
		if (fileFilename() === "") {
			setFileInlineUrl("");
			return;
		}

		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${id}/file/download-url?inline=1`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to get inline URL: ${res.status} ${res.statusText}`,
				);
			}
			const json = (await res.json()) as unknown as {
				download_url?: string;
			};
			setFileInlineUrl(String(json?.download_url ?? ""));
		} catch {
			setFileInlineUrl("");
		}
	};

	createEffect(() => {
		if (type() !== "person") return;
		if (
			personFirstName() !== "" ||
			personLastName() !== "" ||
			personDateOfBirth() !== ""
		) {
			return;
		}
		const fp = formerProperties();
		const person = fp.person;
		if (!person || typeof person !== "object") return;
		const p = person as Record<string, unknown>;
		if (typeof p.first_name === "string") setPersonFirstName(p.first_name);
		if (typeof p.last_name === "string") setPersonLastName(p.last_name);
		if (typeof p.date_of_birth === "string") {
			setPersonDateOfBirth(p.date_of_birth);
		}
	});

	createEffect(() => {
		if (!isEditing()) return;
		if (type() !== "person") return;
		if (titleIsManual()) return;

		const derived = personDerivedTitle();
		if (derived === "") return;
		setTitle(derived);
	});

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

		const canEmbedImage =
			target.type === "file" &&
			String(target.properties?.mime_type ?? "").startsWith("image/");
		const shouldEmbed = mentionEmbedImage() && canEmbedImage;
		const text = shouldEmbed
			? `![${target.title}](note:${target.id})`
			: `[${target.title}](note:${target.id})`;
		const prefix = content() === "" ? "" : "\n\n";
		setContent(`${content()}${prefix}${text}`);
	};

	const saveNote = async () => {
		if (!isEditing()) return;
		const noteType = type();
		const t = title().trim();
		const titleForSave =
			noteType === "person" && t === "" ? personDerivedTitle() : t;
		if (titleForSave === "") {
			setError("Title is required");
			return;
		}

		const properties =
			noteType === "person"
				? {
						first_name: personFirstName().trim(),
						last_name: personLastName().trim(),
						date_of_birth: personDateOfBirth().trim(),
					}
				: {};

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
					body: JSON.stringify({
						title: titleForSave,
						content: content(),
						type: noteType,
						properties,
					}),
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
					body: JSON.stringify({
						title: titleForSave,
						content: content(),
						type: noteType,
						properties,
					}),
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

	createEffect(() => {
		void selectedId();
		void type();
		void fileFilename();
		void loadFileInlineUrl();
	});

	const doUploadFile = async (file: File, opts: { forceNew: boolean }) => {
		const filename = file.name;
		const ext = filename.includes(".") ? (filename.split(".").pop() ?? "") : "";
		const mime = file.type;

		let id = selectedId();
		if (opts.forceNew) {
			id = "";
		}

		if (id === "") {
			const createRes = await apiFetch(`/api/nooks/${nookId()}/notes`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title: filename,
					content: "",
					type: "file",
					properties: {},
				}),
			});
			if (!createRes.ok) {
				throw new Error(
					`Failed to create file note: ${createRes.status} ${createRes.statusText}`,
				);
			}
			const createJson = await createRes.json();
			const createBody = NoteResponseSchema.parse(createJson);
			setNotes([createBody.note, ...notes()]);
			selectNote(createBody.note);
			id = createBody.note.id;
		}

		const res = await apiFetch(
			`/api/nooks/${nookId()}/notes/${id}/file/upload-url`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filename,
					extension: ext,
					filesize: file.size,
					mime_type: mime,
					checksum: "",
				}),
			},
		);
		if (!res.ok) {
			throw new Error(
				`Failed to get upload URL: ${res.status} ${res.statusText}`,
			);
		}
		const json = (await res.json()) as unknown as {
			upload_url?: string;
		};
		const uploadUrl = String(json?.upload_url ?? "");
		if (uploadUrl === "") {
			throw new Error("Upload URL missing from response");
		}

		const putRes = await fetch(uploadUrl, {
			method: "PUT",
			body: file,
		});
		if (!putRes.ok) {
			throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);
		}

		setFileFilename(filename);
		setFileExtension(ext);
		setFileFilesize(String(file.size));
		setFileMimeType(mime);
		setFileChecksum("");
		setTitleFromUser(filename);
		setContent("");
		await loadNotes();
		await loadFileInlineUrl();
	};

	const uploadFile = async (file: File) => {
		if (!isEditing()) return;
		if (type() !== "file") {
			setError("Note type must be file");
			return;
		}

		setFileUploadInProgress(true);
		setLoading(true);
		setError("");
		try {
			await doUploadFile(file, { forceNew: false });
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
			setFileUploadInProgress(false);
		}
	};

	const quickUploadFile = async (file: File) => {
		const previousMode = mode();

		setMode("edit");
		setType("file");
		setSelectedId("");
		setFileFilename("");

		setFileUploadInProgress(true);
		setLoading(true);
		setError("");
		try {
			await doUploadFile(file, { forceNew: true });
			setMode(previousMode);
		} catch (e) {
			setError(String(e));
			setMode(previousMode);
		} finally {
			setLoading(false);
			setFileUploadInProgress(false);
		}
	};

	const downloadFile = async () => {
		const id = selectedId();
		if (id === "") return;
		if (type() !== "file") return;

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${id}/file/download-url`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to get download URL: ${res.status} ${res.statusText}`,
				);
			}
			const json = (await res.json()) as unknown as {
				download_url?: string;
			};
			const downloadUrl = String(json?.download_url ?? "");
			if (downloadUrl === "") {
				throw new Error("Download URL missing from response");
			}
			window.open(downloadUrl, "_blank");
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	return {
		notes,
		selectedId,
		title,
		content,
		type,
		personFirstName,
		personLastName,
		personDateOfBirth,
		fileFilename,
		fileExtension,
		fileFilesize,
		fileMimeType,
		fileChecksum,
		fileInlineUrl,
		formerProperties,
		mode,
		loading,
		error,
		mentionTargetId,
		mentionEmbedImage,
		outgoingMentions,
		incomingMentions,
		fileUploadInProgress,
		isEditing,
		setTitle: setTitleFromUser,
		setContent,
		setType,
		setPersonFirstName,
		setPersonLastName,
		setPersonDateOfBirth,
		setFileFilename,
		setFileExtension,
		setFileFilesize,
		setFileMimeType,
		setFileChecksum,
		setFormerProperties,
		setMode,
		setMentionTargetId,
		setMentionEmbedImage,
		loadNotes,
		loadMentions,
		newNote,
		selectNote,
		onNoteLinkClick,
		insertMention,
		resolveEmbeddedImageSrc,
		uploadEmbeddedImage,
		saveNote,
		deleteNote,
		uploadFile,
		quickUploadFile,
		downloadFile,
	};
}
