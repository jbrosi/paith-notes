import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import {
	parseTypedSearch,
	rankNotesByQuery,
	resolveTypeIdForTerm,
} from "../../noteSearch";
import type { Mention, Note, NoteSummary, NoteType } from "./types";
import {
	MentionsResponseSchema,
	NoteResponseSchema,
	NoteTypeNotesResponseSchema,
	NoteTypeResponseSchema,
	NoteTypesListResponseSchema,
} from "./types";

export function createNookStore(nookId: () => string) {
	const fileInlineUrlCache = new Map<string, string>();
	const noteDetailCache = new Map<string, Note>();
	let lastDetailRequestId = 0;
	const normalizeMimeType = (mime: string) => {
		return String(mime ?? "")
			.trim()
			.toLowerCase()
			.split(";")[0]
			?.trim();
	};
	const normalizeExtension = (ext: string) => {
		const e = String(ext ?? "")
			.trim()
			.toLowerCase();
		if (e === "") return "";
		return e.startsWith(".") ? e.slice(1) : e;
	};
	const filePublicPath = (noteId: string, ext: string) => {
		const id = noteId.trim();
		const n = nookId().trim();
		if (id === "" || n === "") return "";
		void ext;
		return `/files/notes/${n}/files/${id}`;
	};
	const [notes, setNotes] = createSignal<NoteSummary[]>([]);
	const [notesNextCursor, setNotesNextCursor] = createSignal<string>("");
	const [notesQuery, setNotesQuery] = createSignal<string>("");
	const [noteTypes, setNoteTypes] = createSignal<NoteType[]>([]);
	const [selectedTypeIds, setSelectedTypeIds] = createSignal<Set<string>>(
		new Set(),
	);
	const [needsLogin, setNeedsLogin] = createSignal<boolean>(false);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [typeId, setTypeId] = createSignal<string>("");
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
	const fileContentType = createMemo(() => normalizeMimeType(fileMimeType()));
	const [fileChecksum, setFileChecksum] = createSignal<string>("");
	const [fileInlineUrl, setFileInlineUrl] = createSignal<string>("");
	const [formerProperties, setFormerProperties] = createSignal<
		Record<string, unknown>
	>({});
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [isDirty, setIsDirty] = createSignal<boolean>(false);
	type PendingNav = { proceed: () => Promise<void> };
	const [pendingNav, setPendingNav] = createSignal<PendingNav | null>(null);
	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [mentionTargetId, setMentionTargetId] = createSignal<string>("");
	const [mentionEmbedImage, setMentionEmbedImage] =
		createSignal<boolean>(false);
	const [mentionCanEmbedImage, setMentionCanEmbedImage] =
		createSignal<boolean>(false);
	const [outgoingMentions, setOutgoingMentions] = createSignal<Mention[]>([]);
	const [incomingMentions, setIncomingMentions] = createSignal<Mention[]>([]);
	const [fileUploadInProgress, setFileUploadInProgress] =
		createSignal<boolean>(false);

	const resolveTypeIdForTermInStore = (termRaw: string) =>
		resolveTypeIdForTerm(noteTypes(), termRaw);

	const toggleSelectedTypeId = (id: string) => {
		const trimmed = id.trim();
		const current = new Set(selectedTypeIds());
		if (trimmed === "") {
			current.clear();
		} else if (current.has(trimmed)) {
			current.delete(trimmed);
		} else {
			current.add(trimmed);
		}
		setSelectedTypeIds(current);
		const parsed = parseTypedSearch(notesQuery());
		if (!parsed.explicitNoType && parsed.typeTerm.trim() !== "") {
			setNotesQuery(parsed.textTerm);
		}
	};

	const clearSelectedTypes = () => setSelectedTypeIds(new Set<string>());

	const activeTypeIds = createMemo((): Set<string> => {
		const parsed = parseTypedSearch(notesQuery());
		if (parsed.explicitNoType) return new Set();
		const typedTypeId = resolveTypeIdForTermInStore(parsed.typeTerm);
		if (typedTypeId !== "") return new Set([typedTypeId]);
		return selectedTypeIds();
	});

	// Single active type for API — use first if multi, or "all"
	const activeTypeId = createMemo(() => {
		const ids = activeTypeIds();
		if (ids.size === 1) return [...ids][0];
		return "";
	});

	const isEditing = () => mode() === "edit";
	const filteredNotes = createMemo(() => notes());

	const personDerivedTitle = () => {
		const first = personFirstName().trim();
		const last = personLastName().trim();
		return `${first} ${last}`.trim();
	};

	const toSummary = (note: Note): NoteSummary => ({
		id: note.id,
		title: note.title,
		typeId: note.typeId,
		type: note.type,
		outgoingMentionsCount: 0,
		incomingMentionsCount: 0,
		outgoingLinksCount: 0,
		incomingLinksCount: 0,
		createdAt: note.createdAt,
	});

	const loadNoteTypes = async () => {
		if (nookId() === "") return;
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/note-types`, {
				method: "GET",
			});
			if (res.status === 401) {
				if (noteTypes().length > 0) setNoteTypes([]);
				return;
			}
			if (!res.ok) {
				throw new Error(
					`Failed to load note types: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypesListResponseSchema.parse(json);
			setNoteTypes(body.types);
		} catch (e) {
			setNoteTypes([]);
			setError(String(e));
		}
	};

	const createNoteType = async (input: {
		key: string;
		label: string;
		parentId: string;
	}): Promise<NoteType | null> => {
		if (nookId() === "") return null;
		const key = input.key.trim();
		const label = input.label.trim();
		if (key === "" || label === "") {
			setError("Key and label are required");
			return null;
		}

		const parentId = input.parentId.trim();
		const parent =
			parentId === "" ? null : noteTypes().find((t) => t.id === parentId);
		const appliesToFiles = parent ? parent.appliesToFiles : true;
		const appliesToNotes = parent ? parent.appliesToNotes : true;

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/note-types`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key,
					label,
					parent_id: parentId,
					applies_to_files: appliesToFiles,
					applies_to_notes: appliesToNotes,
				}),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to create type: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypeResponseSchema.parse(json);
			setNoteTypes([body.type, ...noteTypes()]);
			return body.type;
		} catch (e) {
			setError(String(e));
			return null;
		} finally {
			setLoading(false);
		}
	};

	const renameNoteType = async (type: NoteType, nextLabel: string) => {
		if (nookId() === "") return;
		const label = nextLabel.trim();
		if (label === "") {
			setError("Label is required");
			return;
		}
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/note-types/${type.id}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						key: type.key,
						label,
						description: type.description,
						parent_id: type.parentId,
						applies_to_files: type.appliesToFiles,
						applies_to_notes: type.appliesToNotes,
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to rename type: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypeResponseSchema.parse(json);
			setNoteTypes(
				noteTypes().map((t) => (t.id === body.type.id ? body.type : t)),
			);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const updateNoteType = async (
		type: NoteType,
		next: {
			key: string;
			label: string;
			description: string;
			parentId: string;
			appliesToFiles: boolean;
			appliesToNotes: boolean;
		},
	): Promise<NoteType | null> => {
		if (nookId() === "") return null;
		const key = next.key.trim();
		const label = next.label.trim();
		if (key === "" || label === "") {
			setError("Key and label are required");
			return null;
		}
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/note-types/${type.id}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						key,
						label,
						description: next.description,
						parent_id: next.parentId,
						applies_to_files: next.appliesToFiles,
						applies_to_notes: next.appliesToNotes,
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to update type: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypeResponseSchema.parse(json);
			setNoteTypes(
				noteTypes().map((t) => (t.id === body.type.id ? body.type : t)),
			);
			return body.type;
		} catch (e) {
			setError(String(e));
			return null;
		} finally {
			setLoading(false);
		}
	};

	const deleteNoteType = async (type: NoteType) => {
		if (nookId() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/note-types/${type.id}`,
				{ method: "DELETE" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to delete type: ${res.status} ${res.statusText}`,
				);
			}
			setNoteTypes(noteTypes().filter((t) => t.id !== type.id));
			if (selectedTypeIds().has(type.id)) {
				const next = new Set(selectedTypeIds());
				next.delete(type.id);
				setSelectedTypeIds(next);
			}
			if (typeId() === type.id) {
				setTypeId("");
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
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

	const setContentFromUser = (next: string) => {
		setContent(next);
		if (mode() === "edit") setIsDirty(true);
	};

	const resolveEmbeddedImageSrc = async (noteId: string) => {
		const id = noteId.trim();
		if (id === "") return null;
		if (nookId() === "") return null;
		const cached = fileInlineUrlCache.get(id);
		if (cached) return cached;

		const d = await loadNoteDetail(id);
		if (!d) return null;
		if (d.type !== "file") return null;
		const mime = String(d.properties?.mime_type ?? "");
		if (!mime.startsWith("image/")) return null;
		const ext = String(d.properties?.extension ?? "");
		const url = `${filePublicPath(id, ext)}?inline=1`;
		if (url === "") return null;
		fileInlineUrlCache.set(id, url);
		return url;
	};

	const loadNoteDetail = async (noteId: string): Promise<Note | null> => {
		const id = noteId.trim();
		if (id === "") return null;
		if (nookId() === "") return null;
		const cached = noteDetailCache.get(id);
		if (cached) {
			if (selectedId() === id) applyNoteDetail(cached);
			return cached;
		}

		const requestId = ++lastDetailRequestId;
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/notes/${id}`, {
				method: "GET",
			});
			if (!res.ok) {
				throw new Error(`Failed to load note: ${res.status} ${res.statusText}`);
			}
			const json = await res.json();
			const body = NoteResponseSchema.parse(json);
			const note = body.note;
			noteDetailCache.set(id, note);

			if (requestId === lastDetailRequestId && selectedId() === id) {
				applyNoteDetail(note);
			}

			return note;
		} catch (e) {
			setError(String(e));
			return null;
		}
	};

	createEffect(() => {
		const id = mentionTargetId().trim();
		if (id === "") {
			setMentionCanEmbedImage(false);
			return;
		}
		void (async () => {
			const d = await loadNoteDetail(id);
			if (!d) {
				setMentionCanEmbedImage(false);
				return;
			}
			const ok =
				d.type === "file" &&
				String(d.properties?.mime_type ?? "").startsWith("image/");
			setMentionCanEmbedImage(ok);
		})();
	});

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

			const res = await apiFetch(`/api/nooks/${nookId()}/file/upload-url`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filename,
					extension: ext,
					filesize: file.size,
					mime_type: mime,
					checksum: "",
				}),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to get embedded upload URL: ${res.status} ${res.statusText}`,
				);
			}
			const json = (await res.json()) as unknown as {
				upload_url?: string;
				upload_id?: string;
			};
			const uploadUrl = String(json?.upload_url ?? "");
			const uploadId = String(json?.upload_id ?? "");
			if (uploadUrl === "") {
				throw new Error("Upload URL missing from response");
			}
			if (uploadId === "") {
				throw new Error("Upload ID missing from response");
			}

			const putRes = await fetch(uploadUrl, {
				method: "PUT",
				credentials: "include",
				body: file,
			});
			if (!putRes.ok) {
				throw new Error(
					`Embedded upload failed: ${putRes.status} ${putRes.statusText}`,
				);
			}

			const finRes = await apiFetch(`/api/nooks/${nookId()}/file/finalize`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ upload_id: uploadId }),
			});
			if (!finRes.ok) {
				throw new Error(
					`Embedded finalize failed: ${finRes.status} ${finRes.statusText}`,
				);
			}
			const finJson = await finRes.json();
			const finBody = NoteResponseSchema.parse(finJson);
			const note = finBody.note;
			const noteId = note.id;
			noteDetailCache.set(noteId, note);
			setNotes([toSummary(note), ...notes()]);

			return noteId;
		} catch (e) {
			setError(String(e));
			return null;
		}
	};

	const loadNotes = async (opts?: { reset?: boolean }) => {
		if (nookId() === "") return;
		if (needsLogin()) return;
		const reset = opts?.reset ?? true;
		const parsed = parseTypedSearch(notesQuery());
		const typedTypeId = resolveTypeIdForTermInStore(parsed.typeTerm);
		const selected = selectedTypeIds();
		const typeForList = parsed.explicitNoType
			? "all"
			: typedTypeId !== ""
				? typedTypeId
				: selected.size === 1
					? [...selected][0]
					: "all";
		const multiTypeFilter =
			!parsed.explicitNoType && typedTypeId === "" && selected.size > 1
				? selected
				: null;
		const cursor = reset ? "" : notesNextCursor();
		const q = parsed.textTerm.trim();

		setLoading(true);
		setError("");
		try {
			const qs = new URLSearchParams();
			qs.set("include_subtypes", "1");
			qs.set("limit", "50");
			if (q !== "") qs.set("q", q);
			if (cursor !== "") qs.set("cursor", cursor);

			const res = await apiFetch(
				`/api/nooks/${nookId()}/note-types/${typeForList}/notes?${qs.toString()}`,
				{ method: "GET" },
			);
			if (res.status === 401) {
				batch(() => {
					setNotes([]);
					setNotesNextCursor("");
					setSelectedId("");
					setNeedsLogin(true);
					setError("Your session timed out. Please log in again.");
				});
				return;
			}
			if (!res.ok) {
				throw new Error(
					`Failed to load notes: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypeNotesResponseSchema.parse(json);
			let fetched = body.notes;
			// Client-side filter when multiple types selected
			if (multiTypeFilter) {
				fetched = fetched.filter(
					(n) => n.typeId !== "" && multiTypeFilter.has(n.typeId),
				);
			}
			const nextNotes = reset ? fetched : [...notes(), ...fetched];
			setNotes(rankNotesByQuery(nextNotes, q));
			setNotesNextCursor(body.nextCursor);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const loadMoreNotes = async () => {
		if (notesNextCursor().trim() === "") return;
		await loadNotes({ reset: false });
	};

	const refreshCurrentNote = async () => {
		const id = selectedId().trim();
		await loadNotes({ reset: true });
		if (id === "") return;
		await loadMentions();
		void loadNoteDetail(id);
	};

	const newNote = () => {
		setSelectedId("");
		const ids = selectedTypeIds();
		setTypeId(ids.size === 1 ? [...ids][0] : "");
		setTitle("New note");
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
		setIsDirty(false);
	};

	const applyNoteDetail = (note: Note) => {
		setIsDirty(false);
		setTypeId(String(note.typeId ?? "").trim());
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
		if (note.type === "file") {
			const extFromProps = normalizeExtension(
				String(note.properties?.extension ?? ""),
			);
			const titleExt = (() => {
				const t = String(note.title ?? "").trim();
				if (t === "") return "";
				const dot = t.lastIndexOf(".");
				if (dot <= 0 || dot === t.length - 1) return "";
				return normalizeExtension(t.slice(dot + 1));
			})();
			const ext = extFromProps !== "" ? extFromProps : titleExt;
			setFileInlineUrl(`${filePublicPath(note.id, ext)}?inline=1`);
		} else {
			setFileInlineUrl("");
		}
		if (note.type === "person") {
			const derived = derivedTitleFromNote(note);
			setTitleIsManual(derived === "" ? true : note.title.trim() !== derived);
		} else {
			setTitleIsManual(true);
		}
		setFormerProperties(note.formerProperties ?? {});
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
	};

	const selectNote = (note: NoteSummary) => {
		setSelectedId(note.id);
		setTypeId(String(note.typeId ?? "").trim());
		setTitle(note.title);
		setType(
			note.type === "person"
				? "person"
				: note.type === "file"
					? "file"
					: "anything",
		);
		setFormerProperties({});
		setPersonFirstName("");
		setPersonLastName("");
		setPersonDateOfBirth("");
		setFileFilename("");
		setFileExtension("");
		setFileFilesize("");
		setFileMimeType("");
		setFileChecksum("");
		setFileInlineUrl("");
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
		void loadMentions();
		void loadNoteDetail(note.id);
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

		const extFromState = normalizeExtension(fileExtension());
		const titleExt = (() => {
			const t = String(title() ?? "").trim();
			if (t === "") return "";
			const dot = t.lastIndexOf(".");
			if (dot <= 0 || dot === t.length - 1) return "";
			return normalizeExtension(t.slice(dot + 1));
		})();
		const ext = extFromState !== "" ? extFromState : titleExt;

		try {
			setFileInlineUrl(`${filePublicPath(id, ext)}?inline=1`);
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

	const onNoteLinkClickInternal = async (noteId: string) => {
		let found = notes().find((n) => n.id === noteId);
		if (!found) {
			clearSelectedTypes();
			await loadNotes({ reset: true });
			found = notes().find((n) => n.id === noteId);
		}
		if (!found) {
			setError(`Note not found: ${noteId}`);
			return;
		}
		selectNote(found);
	};

	const onNoteLinkClick = async (noteId: string) => {
		if (isDirty()) {
			setPendingNav({ proceed: () => onNoteLinkClickInternal(noteId) });
			return;
		}
		await onNoteLinkClickInternal(noteId);
	};

	const insertMention = async () => {
		if (!isEditing()) return;
		const targetId = mentionTargetId();
		if (targetId === "") return;
		const target = notes().find((n) => n.id === targetId) ?? null;
		const title = target?.title?.trim()
			? target.title
			: ((await loadNoteDetail(targetId))?.title ?? "");
		if (title.trim() === "") return;
		const shouldEmbed = mentionEmbedImage() && mentionCanEmbedImage();
		const text = shouldEmbed
			? `![${title}](note:${targetId})`
			: `[${title}](note:${targetId})`;
		const prefix = content() === "" ? "" : "\n\n";
		setContentFromUser(`${content()}${prefix}${text}`);
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
				: null;

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
						type_id: typeId(),
						...(properties ? { properties } : {}),
					}),
				});
				if (!res.ok) {
					throw new Error(
						`Failed to create note: ${res.status} ${res.statusText}`,
					);
				}
				const json = await res.json();
				const body = NoteResponseSchema.parse(json);
				noteDetailCache.set(body.note.id, body.note);
				setNotes([toSummary(body.note), ...notes()]);
				setSelectedId(body.note.id);
				applyNoteDetail(body.note);
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
						type_id: typeId(),
						...(properties ? { properties } : {}),
					}),
				});
				if (!res.ok) {
					throw new Error(
						`Failed to update note: ${res.status} ${res.statusText}`,
					);
				}
				const json = await res.json();
				const body = NoteResponseSchema.parse(json);
				noteDetailCache.set(body.note.id, body.note);
				setNotes(
					notes().map((n) =>
						n.id === body.note.id ? toSummary(body.note) : n,
					),
				);
				setSelectedId(body.note.id);
				applyNoteDetail(body.note);
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

			noteDetailCache.delete(id);
			fileInlineUrlCache.delete(id);
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

	const confirmPendingNav = async (save: boolean) => {
		const nav = pendingNav();
		if (!nav) return;
		setPendingNav(null);
		if (save) {
			await saveNote();
			if (error() !== "") return;
		} else {
			setIsDirty(false);
		}
		await nav.proceed();
	};

	const cancelPendingNav = () => {
		setPendingNav(null);
	};

	createEffect(() => {
		void nookId();
		void loadNoteTypes();
	});

	// Clear all state when switching nooks
	let prevNookId = nookId();
	createEffect(() => {
		const current = nookId();
		if (prevNookId !== current) {
			prevNookId = current;
			batch(() => {
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
				setFileInlineUrl("");
				setFormerProperties({});
				setMode("view");
				setIsDirty(false);
				setError("");
				setNotes([]);
				setNotesNextCursor("");
				setNoteTypes([]);
				setOutgoingMentions([]);
				setIncomingMentions([]);
				setMentionTargetId("");
				setMentionEmbedImage(false);
				setNeedsLogin(false);
			});
			noteDetailCache.clear();
			fileInlineUrlCache.clear();
		}
	});

	createEffect(() => {
		void nookId();
		void selectedTypeIds();
		void notesQuery();
		void loadNotes({ reset: true });
	});

	createEffect(() => {
		void selectedId();
		void type();
		void fileExtension();
		void title();
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

		const initPath =
			id === ""
				? `/api/nooks/${nookId()}/file/upload-url`
				: `/api/nooks/${nookId()}/notes/${id}/file/upload-url`;

		const res = await apiFetch(initPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				filename,
				extension: ext,
				filesize: file.size,
				mime_type: mime,
				checksum: "",
			}),
		});
		if (!res.ok) {
			throw new Error(
				`Failed to get upload URL: ${res.status} ${res.statusText}`,
			);
		}
		const json = (await res.json()) as unknown as {
			upload_url?: string;
			upload_id?: string;
		};
		const uploadUrl = String(json?.upload_url ?? "");
		const uploadId = String(json?.upload_id ?? "");
		if (uploadUrl === "") {
			throw new Error("Upload URL missing from response");
		}
		if (uploadId === "") {
			throw new Error("Upload ID missing from response");
		}

		const putRes = await fetch(uploadUrl, {
			method: "PUT",
			credentials: "include",
			body: file,
		});
		if (!putRes.ok) {
			throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);
		}

		const finRes = await apiFetch(
			id === ""
				? `/api/nooks/${nookId()}/file/finalize`
				: `/api/nooks/${nookId()}/notes/${id}/file/finalize`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ upload_id: uploadId }),
			},
		);
		if (!finRes.ok) {
			throw new Error(`Finalize failed: ${finRes.status} ${finRes.statusText}`);
		}

		if (id === "") {
			const finJson = await finRes.json();
			const finBody = NoteResponseSchema.parse(finJson);
			noteDetailCache.set(finBody.note.id, finBody.note);
			setNotes([toSummary(finBody.note), ...notes()]);
			setSelectedId(finBody.note.id);
			applyNoteDetail(finBody.note);
			id = finBody.note.id;
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
			window.open(filePublicPath(id, fileExtension()), "_blank");
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	return {
		nookId,
		notes: filteredNotes,
		allNotes: notes,
		notesNextCursor,
		notesQuery,
		noteTypes,
		loadNoteTypes,
		selectedTypeIds,
		typeId,
		needsLogin,
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
		fileContentType,
		fileChecksum,
		fileInlineUrl,
		formerProperties,
		mode,
		isDirty,
		pendingNav,
		loading,
		error,
		mentionTargetId,
		mentionEmbedImage,
		mentionCanEmbedImage,
		outgoingMentions,
		incomingMentions,
		fileUploadInProgress,
		isEditing,
		setTitle: setTitleFromUser,
		setContent: setContentFromUser,
		confirmPendingNav,
		cancelPendingNav,
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
		toggleSelectedTypeId,
		clearSelectedTypes,
		activeTypeIds,
		setNotesQuery: (next: string) => setNotesQuery(String(next ?? "")),
		activeTypeId,
		setTypeId: (next: string) => setTypeId(next.trim()),
		loadNotes,
		loadMoreNotes,
		refreshCurrentNote,
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
		createNoteType,
		renameNoteType,
		updateNoteType,
		deleteNoteType,
	};
}

export type NookStore = ReturnType<typeof createNookStore>;
