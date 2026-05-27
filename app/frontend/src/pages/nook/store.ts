import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import {
	parseTypedSearch,
	rankNotesByQuery,
	resolveTypeIdForTerm,
} from "../../noteSearch";
import type {
	GraphViewProperties,
	Mention,
	Note,
	NoteHistoryEntry,
	NoteSummary,
	NoteType,
} from "./types";
import {
	MentionsResponseSchema,
	NoteHistoryResponseSchema,
	NoteResponseSchema,
	NoteTypeNotesResponseSchema,
	NoteTypeResponseSchema,
	NoteTypesListResponseSchema,
	parseGraphProperties,
	serializeGraphProperties,
} from "./types";

export function createNookStore(nookId: () => string) {
	const fileInlineUrlCache = new Map<string, string>();
	// Key: "nookId:noteId" → title
	const noteTitleCache = new Map<string, string>();
	const nookTitleCache = new Map<string, string>();
	const titleFetchInFlight = new Set<string>();
	const [titleCacheVersion, setTitleCacheVersion] = createSignal(0);
	const bumpTitleCache = () => setTitleCacheVersion((v) => v + 1);
	const titleKey = (nook: string, noteId: string) => `${nook}:${noteId}`;
	const cacheTitles = (
		entries: Array<{ id: string; title: string }>,
		forNookId?: string,
	) => {
		const nook = forNookId ?? nookId();
		let changed = false;
		for (const e of entries) {
			const key = titleKey(nook, e.id);
			if (e.id && e.title && noteTitleCache.get(key) !== e.title) {
				noteTitleCache.set(key, e.title);
				changed = true;
			}
		}
		if (changed) bumpTitleCache();
	};
	const cacheNookName = (id: string, name: string) => {
		if (id && name && nookTitleCache.get(id) !== name) {
			nookTitleCache.set(id, name);
			bumpTitleCache();
		}
	};
	const fetchMissingTitles = (
		refs: Array<{ nookId: string; noteId: string }>,
	) => {
		const missing = refs.filter((r) => {
			const targetNook = r.nookId || nookId();
			const key = titleKey(targetNook, r.noteId);
			return (
				r.noteId !== "" &&
				!noteTitleCache.has(key) &&
				!titleFetchInFlight.has(key)
			);
		});
		if (missing.length === 0) return;
		for (const r of missing)
			titleFetchInFlight.add(titleKey(r.nookId || nookId(), r.noteId));
		void Promise.all(
			missing.map(async (r) => {
				const targetNook = r.nookId || nookId();
				const key = titleKey(targetNook, r.noteId);
				try {
					const res = await apiFetch(
						`/api/nooks/${targetNook}/notes/${r.noteId}`,
						{ method: "GET" },
					);
					if (!res.ok) return;
					const json = await res.json();
					const body = NoteResponseSchema.parse(json);
					cacheTitles(
						[{ id: body.note.id, title: body.note.title }],
						targetNook,
					);
				} catch {
					// best-effort — user may not have access to that nook
				} finally {
					titleFetchInFlight.delete(key);
				}
			}),
		);
	};
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
	const [nookName, setNookName] = createSignal<string>("");
	const [nookRole, setNookRole] = createSignal<string>("unknown");
	const canWrite = createMemo(() => {
		const role = nookRole();
		return role !== "unknown" && role !== "readonly";
	});
	const [notes, setNotes] = createSignal<NoteSummary[]>([]);
	const [notesNextCursor, setNotesNextCursor] = createSignal<string>("");
	const [notesQuery, setNotesQuery] = createSignal<string>("");
	const [noteTypes, setNoteTypes] = createSignal<NoteType[]>([]);
	const [selectedTypeIds, setSelectedTypeIds] = createSignal<Set<string>>(
		new Set(),
	);
	const [selectedId, setSelectedId] = createSignal<string>("");
	const [typeId, setTypeId] = createSignal<string>("");
	const [title, setTitle] = createSignal<string>("");
	const [titleIsManual, setTitleIsManual] = createSignal<boolean>(false);
	const [content, setContent] = createSignal<string>("");
	const [type, setType] = createSignal<"anything" | "file" | "graph">(
		"anything",
	);
	const [fileFilename, setFileFilename] = createSignal<string>("");
	const [fileExtension, setFileExtension] = createSignal<string>("");
	const [fileFilesize, setFileFilesize] = createSignal<string>("");
	const [fileMimeType, setFileMimeType] = createSignal<string>("");
	const fileContentType = createMemo(() => normalizeMimeType(fileMimeType()));
	const [fileChecksum, setFileChecksum] = createSignal<string>("");
	const [fileInlineUrl, setFileInlineUrl] = createSignal<string>("");
	const [graphProperties, setGraphProperties] =
		createSignal<GraphViewProperties | null>(null);
	const [formerProperties, setFormerProperties] = createSignal<
		Record<string, unknown>
	>({});
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [isDirty, setIsDirty] = createSignal<boolean>(false);
	type PendingNav = { proceed: () => void | Promise<void> };
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
	const [noteVersion, setNoteVersion] = createSignal<number>(0);
	const [viewCount, setViewCount] = createSignal<number>(0);
	const [remoteVersion, setRemoteVersion] = createSignal<number>(0);
	const [noteViewers, setNoteViewers] = createSignal<
		Array<{ user_id: string; user_name: string }>
	>([]);
	let presenceInterval: ReturnType<typeof setInterval> | null = null;

	const pollPresence = async () => {
		const nook = nookId();
		const note = selectedId();
		if (!nook || !note) return;
		try {
			const res = await apiFetch(`/api/nooks/${nook}/notes/${note}/presence`, {
				method: "GET",
			});
			if (!res.ok) return;
			const body = (await res.json()) as {
				version?: number;
				viewers?: Array<{ user_id: string; user_name: string }>;
			};
			if (body.version !== undefined) {
				setRemoteVersion(body.version);
			}
			setNoteViewers(body.viewers ?? []);
		} catch {
			// best-effort
		}
	};

	const startPresencePolling = () => {
		stopPresencePolling();
		void pollPresence();
		presenceInterval = setInterval(() => void pollPresence(), 30000);
	};

	const stopPresencePolling = () => {
		if (presenceInterval) {
			clearInterval(presenceInterval);
			presenceInterval = null;
		}
		setNoteViewers([]);
		setRemoteVersion(0);
	};
	const [conflictError, setConflictError] = createSignal<{
		currentVersion: number;
		expectedVersion: number;
	} | null>(null);
	const [noteHistory, setNoteHistory] = createSignal<NoteHistoryEntry[]>([]);
	const [selectedVersion, setSelectedVersion] = createSignal<number | null>(
		null,
	);
	const [snapshotData, setSnapshotData] = createSignal<{
		historyId: number;
		version: number;
		action: string;
		actor: string;
		userName: string;
		createdAt: string;
		title: string;
		content: string;
	} | null>(null);
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

	const clearSelectedTypes = () => {
		if (selectedTypeIds().size > 0) setSelectedTypeIds(new Set<string>());
	};

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
		const appliesTo = parent ? parent.appliesTo : "notes";

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
					applies_to: appliesTo,
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
						applies_to: type.appliesTo,
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
			appliesTo: "notes" | "files";
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
						applies_to: next.appliesTo,
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

	const setTitleFromUser = (next: string) => {
		setTitle(next);
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
			cacheTitles([{ id: note.id, title: note.title }]);

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
			// Cache titles, grouping by nook for correct cache keys
			const currentNook = nookId();
			for (const m of [...body.outgoing, ...body.incoming]) {
				cacheTitles(
					[{ id: m.noteId, title: m.noteTitle }],
					m.nookId || currentNook,
				);
			}
			setOutgoingMentions(body.outgoing);
			setIncomingMentions(body.incoming);
		} catch (e) {
			setOutgoingMentions([]);
			setIncomingMentions([]);
			setError(String(e));
		}
	};

	const loadHistory = async () => {
		if (nookId() === "") return;
		const noteId = selectedId();
		if (noteId === "") {
			setNoteHistory([]);
			return;
		}

		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId}/history`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const json = await res.json();
			const body = NoteHistoryResponseSchema.parse(json);
			setNoteHistory(body.history);
		} catch {
			setNoteHistory([]);
		}
	};

	const viewVersion = async (versionOrHistoryId: number, byVersion = false) => {
		const noteId = selectedId();
		if (nookId() === "" || noteId === "") return;

		const param = byVersion
			? `v${versionOrHistoryId}`
			: String(versionOrHistoryId);
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId}/history/${param}`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const json = (await res.json()) as {
				snapshot?: {
					history_id: number;
					version: number;
					action: string;
					actor: string;
					user_name: string;
					created_at: string;
					note: { title: string; content: string };
				};
			};
			const s = json?.snapshot;
			if (!s) return;
			setSelectedVersion(s.version);
			setSnapshotData({
				historyId: s.history_id,
				version: s.version,
				action: s.action,
				actor: s.actor,
				userName: s.user_name,
				createdAt: s.created_at,
				title: s.note.title,
				content: s.note.content,
			});
		} catch {
			// best-effort
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
			cacheTitles([{ id: noteId, title: note.title }]);
			setNotes([toSummary(note), ...notes()]);

			return noteId;
		} catch (e) {
			setError(String(e));
			return null;
		}
	};

	let loadNotesVersion = 0;
	let loadNotesAbort: AbortController | null = null;

	const loadNotes = async (opts?: { reset?: boolean }) => {
		if (nookId() === "") return;
		loadNotesAbort?.abort();
		const version = ++loadNotesVersion;
		const abort = new AbortController();
		loadNotesAbort = abort;
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
			if (parsed.unlinked) qs.set("unlinked", "1");

			const res = await apiFetch(
				`/api/nooks/${nookId()}/note-types/${typeForList}/notes?${qs.toString()}`,
				{ method: "GET", signal: abort.signal },
			);
			if (version !== loadNotesVersion) return;
			if (!res.ok) {
				throw new Error(
					`Failed to load notes: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			if (version !== loadNotesVersion) return;
			const body = NoteTypeNotesResponseSchema.parse(json);
			let fetched = body.notes;
			// Client-side filter when multiple types selected
			if (multiTypeFilter) {
				fetched = fetched.filter(
					(n) => n.typeId !== "" && multiTypeFilter.has(n.typeId),
				);
			}
			const nextNotes = reset ? fetched : [...notes(), ...fetched];
			cacheTitles(fetched.map((n) => ({ id: n.id, title: n.title })));
			setNotes(rankNotesByQuery(nextNotes, q));
			setNotesNextCursor(body.nextCursor);
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			if (version !== loadNotesVersion) return;
			setError(String(e));
		} finally {
			if (version === loadNotesVersion) {
				setLoading(false);
			}
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
		void loadHistory();
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
		setFileFilename("");
		setFileExtension("");
		setFileFilesize("");
		setFileMimeType("");
		setFileChecksum("");
		setGraphProperties(null);
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
			note.type === "file"
				? "file"
				: note.type === "graph"
					? "graph"
					: "anything",
		);
		setFileFilename(String(note.properties?.filename ?? ""));
		setFileExtension(String(note.properties?.extension ?? ""));
		setFileFilesize(String(note.properties?.filesize ?? ""));
		setFileMimeType(String(note.properties?.mime_type ?? ""));
		setFileChecksum(String(note.properties?.checksum ?? ""));
		setGraphProperties(
			note.type === "graph" ? parseGraphProperties(note.properties) : null,
		);
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
		setTitleIsManual(true);
		setFormerProperties(note.formerProperties ?? {});
		setNoteVersion(note.version ?? 0);
		setViewCount(note.viewCount ?? 0);
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
	};

	const selectNote = (note: NoteSummary) => {
		setSelectedVersion(null);
		setSnapshotData(null);
		setSelectedId(note.id);
		setTypeId(String(note.typeId ?? "").trim());
		setTitle(note.title);
		setType(
			note.type === "file"
				? "file"
				: note.type === "graph"
					? "graph"
					: "anything",
		);
		setFormerProperties({});
		setFileFilename("");
		setFileExtension("");
		setFileFilesize("");
		setFileMimeType("");
		setFileChecksum("");
		setGraphProperties(null);
		setFileInlineUrl("");
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
		void loadMentions();
		void loadHistory();
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

	// Navigation callback — set by Nook.tsx to use the router's navigate()
	let navigatorFn: ((noteId: string, nookId?: string) => void) | null = null;
	const setNavigator = (fn: (noteId: string, nookId?: string) => void) => {
		navigatorFn = fn;
	};

	const onNoteLinkClickInternal = (noteId: string, targetNookId?: string) => {
		if (navigatorFn) {
			navigatorFn(noteId, targetNookId);
		}
	};

	const onNoteLinkClick = (noteId: string, targetNookId?: string) => {
		if (isDirty()) {
			setPendingNav({
				proceed: () => onNoteLinkClickInternal(noteId, targetNookId),
			});
			return;
		}
		onNoteLinkClickInternal(noteId, targetNookId);
	};

	/** Load a note by ID into the store (called by URL→store sync) */
	const loadNoteById = async (noteId: string) => {
		const found = notes().find((n) => n.id === noteId);
		if (found) {
			selectNote(found);
			return;
		}
		// Note not in current list — fetch it directly instead of reloading
		// the full list (which races with the reactive loadNotes effect).
		const detail = await loadNoteDetail(noteId);
		if (!detail) {
			setError(`Note not found: ${noteId}`);
			return;
		}
		selectNote(toSummary(detail));
	};

	const insertMention = async () => {
		if (!isEditing()) return;
		const targetId = mentionTargetId();
		if (targetId === "") return;
		const cached = noteTitleCache.get(titleKey(nookId(), targetId));
		const title = cached?.trim()
			? cached
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
		setConflictError(null);
		if (!isEditing()) return;
		const noteType = type();
		const titleForSave = title().trim();
		if (titleForSave === "") {
			setError("Title is required");
			return;
		}

		const properties =
			noteType === "graph" && graphProperties()
				? serializeGraphProperties(graphProperties() as GraphViewProperties)
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
				cacheTitles([{ id: body.note.id, title: body.note.title }]);
				setNotes([toSummary(body.note), ...notes()]);
				setSelectedId(body.note.id);
				applyNoteDetail(body.note);
				await loadMentions();
				void loadHistory();
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
						...(noteVersion() > 0 ? { expected_version: noteVersion() } : {}),
					}),
				});
				if (res.status === 409) {
					const body = (await res.json()) as {
						current_version?: number;
						expected_version?: number;
					};
					setConflictError({
						currentVersion: body?.current_version ?? 0,
						expectedVersion: body?.expected_version ?? noteVersion(),
					});
					return;
				}
				if (!res.ok) {
					throw new Error(
						`Failed to update note: ${res.status} ${res.statusText}`,
					);
				}
				const json = await res.json();
				const body = NoteResponseSchema.parse(json);
				cacheTitles([{ id: body.note.id, title: body.note.title }]);
				setNotes(
					notes().map((n) =>
						n.id === body.note.id ? toSummary(body.note) : n,
					),
				);
				setSelectedId(body.note.id);
				applyNoteDetail(body.note);
				await loadMentions();
				void loadHistory();
			}
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	/** Accept the conflict: update local version to latest so next save will succeed */
	const resolveConflict = () => {
		const conflict = conflictError();
		if (conflict) {
			setNoteVersion(conflict.currentVersion);
		}
		setConflictError(null);
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

			noteTitleCache.delete(id);
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
				setFileFilename("");
				setFileExtension("");
				setFileFilesize("");
				setFileMimeType("");
				setFileChecksum("");
				setGraphProperties(null);
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
			});
			noteTitleCache.clear();
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
			cacheTitles([{ id: finBody.note.id, title: finBody.note.title }]);
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
		setGraphProperties(null);
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

	// Start/stop presence polling based on selected note
	createEffect(() => {
		const note = selectedId();
		if (note !== "") {
			startPresencePolling();
		} else {
			stopPresencePolling();
		}
	});

	return {
		nookId,
		nookName,
		setNookName,
		nookRole,
		setNookRole,
		canWrite,
		notes: filteredNotes,
		allNotes: notes,
		notesNextCursor,
		notesQuery,
		noteTypes,
		loadNoteTypes,
		selectedTypeIds,
		typeId,
		selectedId,
		setSelectedId,
		title,
		content,
		type,
		fileFilename,
		fileExtension,
		fileFilesize,
		fileMimeType,
		fileContentType,
		fileChecksum,
		fileInlineUrl,
		graphProperties,
		setGraphProperties,
		formerProperties,
		mode,
		isDirty,
		setIsDirty,
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
		noteHistory,
		loadHistory,
		selectedVersion,
		setSelectedVersion: (v: number | null) => {
			setSelectedVersion(v);
			if (v === null) setSnapshotData(null);
		},
		snapshotData,
		viewVersion,
		noteVersion,
		viewCount,
		noteHasUpdate: () => remoteVersion() > 0 && remoteVersion() > noteVersion(),
		noteViewers,
		conflictError,
		resolveConflict,
		newNote,
		selectNote,
		onNoteLinkClick,
		setNavigator,
		loadNoteById,
		insertMention,
		titleCacheVersion,
		cacheTitles,
		cacheNookName,
		fetchMissingTitles,
		resolveNoteTitle: (id: string, forNookId?: string): string | undefined => {
			void titleCacheVersion();
			return noteTitleCache.get(titleKey(forNookId ?? nookId(), id));
		},
		resolveNookName: (id: string): string | undefined => {
			void titleCacheVersion();
			return nookTitleCache.get(id);
		},
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
