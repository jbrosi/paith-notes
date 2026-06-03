import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import {
	parseTypedSearch,
	rankNotesByQuery,
	resolveTypeIdForTerm,
} from "../../noteSearch";
import type {
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

} from "./types";

export function createNookStore(nookId: () => string) {
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
	const [noteAttributes, setNoteAttributes] = createSignal<
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
	const [remoteNoteChanged, setRemoteNoteChanged] = createSignal<boolean>(false);
	const [noteViewers, setNoteViewers] = createSignal<
		Array<{ user_id: string; user_name: string }>
	>([]);

	// ── WebSocket event connection ──────────────────────────────────────────
	let ws: WebSocket | null = null;
	let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let wsNookId = "";
	let wsUserId = ""; // Our own user ID, received from server on connect

	const wsSend = (data: Record<string, unknown>) => {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(data));
		}
	};

	const wsConnect = (nook: string) => {
		wsDisconnect();
		wsNookId = nook;
		if (!nook) return;

		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${proto}//${window.location.host}/ws/nooks/${encodeURIComponent(nook)}`;
		const socket = new WebSocket(url);
		ws = socket;

		socket.onopen = () => {
			// Send current viewing state
			const note = selectedId();
			if (note) wsSend({ type: "viewing", note_id: note });
		};

		socket.onmessage = (e) => {
			try {
				const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
				switch (msg.type) {
					case "connected":
						wsUserId = String(msg.user_id ?? "");
						break;
					case "types_changed": {
						const v = typeof msg.version === "number" ? msg.version : 0;
						if (v === 0 || v > typesVersion) {
							void loadNoteTypes();
						}
						break;
					}
					case "note_changed": {
						const changedId = String(msg.id ?? "");
						void loadNotes({ reset: true });
						if (changedId && changedId === selectedId()) {
							if (isEditing()) {
								// Show "updated by someone else" banner — user can
								// choose to reload. Save conflict is still handled
								// server-side via expected_version.
								setRemoteNoteChanged(true);
							} else {
								void loadNoteDetail(changedId);
								void loadMentions();
								void loadHistory();
							}
						}
						break;
					}
					case "links_changed":
						void loadNotes({ reset: true });
						if (selectedId()) void loadMentions();
						break;
					case "presence": {
						const noteId = String(msg.note_id ?? "");
						if (noteId === selectedId()) {
							const all = Array.isArray(msg.viewers)
								? (msg.viewers as Array<{ user_id: string; user_name: string }>)
								: [];
							// Filter out ourselves — only show other users
							const others = all.filter((v) => v.user_id !== wsUserId);
							setNoteViewers(others);
						}
						break;
					}
				}
			} catch {
				// ignore malformed messages
			}
		};

		socket.onclose = () => {
			ws = null;
			// Reconnect after delay if we're still on this nook
			if (wsNookId === nook) {
				wsReconnectTimer = setTimeout(() => wsConnect(nook), 3000);
			}
		};

		socket.onerror = () => {
			// onclose will fire after onerror
		};
	};

	const wsDisconnect = () => {
		if (wsReconnectTimer) {
			clearTimeout(wsReconnectTimer);
			wsReconnectTimer = null;
		}
		wsNookId = "";
		if (ws) {
			ws.close();
			ws = null;
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
		outgoingMentionsCount: 0,
		incomingMentionsCount: 0,
		outgoingLinksCount: 0,
		incomingLinksCount: 0,
		createdAt: note.createdAt,
	});

	let typesVersion = 0;

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
			typesVersion = body.version;
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
				}),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to create type: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypeResponseSchema.parse(json);
			await loadNoteTypes();
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
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to rename type: ${res.status} ${res.statusText}`,
				);
			}
			await loadNoteTypes();
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
			await loadNoteTypes();
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
			await loadNoteTypes();
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

	const embeddedImageCache = new Map<string, string>();
	const resolveEmbeddedImageSrc = async (noteId: string) => {
		const id = noteId.trim();
		const nook = nookId();
		if (id === "" || nook === "") return null;
		const cached = embeddedImageCache.get(id);
		if (cached) return cached;

		const d = await loadNoteDetail(id);
		if (!d) return null;

		// Find the first file attribute with an image content_type
		const attrs =
			(d as unknown as { attributes?: Record<string, unknown> }).attributes ??
			{};
		let fileAttrId = "";
		for (const [attrId, val] of Object.entries(attrs)) {
			if (typeof val === "object" && val !== null) {
				const ct = String((val as Record<string, unknown>).content_type ?? "");
				if (ct.startsWith("image/")) {
					fileAttrId = attrId;
					break;
				}
			}
		}
		if (!fileAttrId) {
			// Fallback: try legacy download endpoint for old file notes
			try {
				const res = await apiFetch(
					`/api/nooks/${nook}/notes/${id}/file/download-url?inline=1`,
				);
				if (!res.ok) return null;
				const json = (await res.json()) as { download_url?: string };
				const url = json?.download_url ?? "";
				if (url) embeddedImageCache.set(id, url);
				return url || null;
			} catch {
				return null;
			}
		}

		try {
			const res = await apiFetch(
				`/api/nooks/${nook}/notes/${id}/attributes/${fileAttrId}/file/download-url?inline=1`,
			);
			if (!res.ok) return null;
			const json = (await res.json()) as { download_url?: string };
			const url = json?.download_url ?? "";
			if (url === "") return null;
			embeddedImageCache.set(id, url);
			return url;
		} catch {
			return null;
		}
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
			const attrs = d.attributes ?? {};
			const ok = Object.values(attrs).some(
				(v) =>
					typeof v === "object" &&
					v !== null &&
					String((v as Record<string, unknown>).content_type ?? "").startsWith(
						"image/",
					),
			);
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

	/** Resolve all attributes for a type, including inherited ones from ancestors. */
	const resolveTypeAttributes = (typeId: string) => {
		const types = noteTypes();
		const typeMap = new Map(types.map((t) => [t.id, t]));
		const seen = new Set<string>();
		const attrs: typeof types[0]["attributes"] = [];
		const namesSeen = new Set<string>();

		let cur = typeId;
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			const t = typeMap.get(cur);
			if (!t) break;
			for (const a of t.attributes) {
				const lower = a.name.toLowerCase();
				if (!namesSeen.has(lower)) {
					namesSeen.add(lower);
					attrs.push(cur === typeId ? a : { ...a, inherited: true });
				}
			}
			cur = t.parentId;
		}
		return attrs;
	};

	const findFileTypeAndAttr = (): { typeId: string; attrId: string } => {
		const types = noteTypes();
		const fileType = types.find((t) => t.key === "file");
		if (!fileType)
			throw new Error(
				'No "File" type found — check your nook type settings',
			);

		const attrs = resolveTypeAttributes(fileType.id);
		const fileAttr = attrs.find((a) => a.kind === "file");
		if (!fileAttr)
			throw new Error(
				'The "File" type has no file attribute — add one in type settings',
			);

		return { typeId: fileType.id, attrId: fileAttr.id };
	};

	const uploadFileToNote = async (
		nook: string,
		file: File,
		typeId: string,
		attrId: string,
	): Promise<Note | null> => {
		const filename = file.name || "upload";
		const ext = filename.includes(".")
			? (filename.split(".").pop() ?? "")
			: "";

		const initRes = await apiFetch(
			`/api/nooks/${nook}/file/attr-upload-url`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filename,
					extension: ext,
					filesize: file.size,
					mime_type: file.type,
					type_id: typeId,
					attribute_id: attrId,
				}),
			},
		);
		if (!initRes.ok) throw new Error("Failed to get upload URL");
		const initData = (await initRes.json()) as {
			upload_url: string;
			upload_id: string;
		};

		const putRes = await fetch(initData.upload_url, {
			method: "PUT",
			credentials: "include",
			body: file,
		});
		if (!putRes.ok) throw new Error("Upload failed");

		const finRes = await apiFetch(`/api/nooks/${nook}/file/attr-finalize`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				upload_id: initData.upload_id,
				type_id: typeId,
				attribute_id: attrId,
			}),
		});
		if (!finRes.ok) throw new Error("Finalize failed");

		const finJson = await finRes.json();
		return NoteResponseSchema.parse(finJson).note;
	};

	const uploadEmbeddedImage = async (file: File) => {
		const nook = nookId();
		if (nook === "") return null;
		setError("");
		try {
			const target = findFileTypeAndAttr();
			const note = await uploadFileToNote(
				nook,
				file,
				target.typeId,
				target.attrId,
			);
			if (!note) return null;
			cacheTitles([{ id: note.id, title: note.title }]);
			setNotes([toSummary(note), ...notes()]);
			return note.id;
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
		setNoteAttributes({});
		setError("");
		setRemoteNoteChanged(false);
		setMentionTargetId("");
		setMentionEmbedImage(false);
		setMode("edit");
		setIsDirty(false);
	};

	const applyNoteDetail = (note: Note) => {
		setIsDirty(false);
		setRemoteNoteChanged(false);
		setTypeId(String(note.typeId ?? "").trim());
		setTitle(note.title);
		setContent(note.content);

		setNoteAttributes(note.attributes ?? {});
		setTitleIsManual(true);
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
		setNoteAttributes({});
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);
		void loadMentions();
		void loadHistory();
		void loadNoteDetail(note.id);
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

	const setNoteAttribute = (attrId: string, value: unknown) => {
		setNoteAttributes((prev) => ({ ...prev, [attrId]: value }));
		setIsDirty(true);
	};

	const loadDetail = async () => {
		const id = selectedId();
		if (id) void loadNoteDetail(id);
	};

	const saveNote = async () => {
		setConflictError(null);
		if (!isEditing()) return;
		const titleForSave = title().trim();
		if (titleForSave === "") {
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
					body: JSON.stringify({
						title: titleForSave,
						content: content(),
						type_id: typeId(),
						attributes: noteAttributes(),
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
						attributes: noteAttributes(),
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
			embeddedImageCache.delete(id);
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
				setNoteAttributes({});
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
			embeddedImageCache.clear();
		}
	});

	createEffect(() => {
		void nookId();
		void selectedTypeIds();
		void notesQuery();
		void loadNotes({ reset: true });
	});

	const uploadFile = async (_file: File) => {};

	const quickUploadFile = async (file: File) => {
		const nook = nookId();
		if (!nook) return;

		setLoading(true);
		setError("");
		try {
			const target = findFileTypeAndAttr();
			const note = await uploadFileToNote(
				nook,
				file,
				target.typeId,
				target.attrId,
			);
			if (!note) throw new Error("Upload failed");

			cacheTitles([{ id: note.id, title: note.title }]);
			setNotes([toSummary(note), ...notes()]);
			// Navigate to the new note in edit mode so the user can adjust title/attributes
			onNoteLinkClickInternal(note.id);
			setMode("edit");
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const downloadFile = async () => {};

	// Connect/disconnect WebSocket when nookId changes
	createEffect(() => {
		const nook = nookId();
		if (nook) {
			wsConnect(nook);
		} else {
			wsDisconnect();
		}
	});

	// Tell the server which note we're viewing
	createEffect(() => {
		const note = selectedId();
		wsSend({ type: "viewing", note_id: note });
		if (!note) {
			setNoteViewers([]);
			setRemoteVersion(0);
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
		isEditing,
		setTitle: setTitleFromUser,
		setContent: setContentFromUser,
		confirmPendingNav,
		cancelPendingNav,
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
		remoteNoteChanged,
		dismissRemoteNoteChanged: () => setRemoteNoteChanged(false),
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
		noteAttributes,
		setNoteAttribute,
		loadDetail,
		uploadFile,
		quickUploadFile,
		downloadFile,
		resolveTypeAttributes,
		createNoteType,
		renameNoteType,
		updateNoteType,
		deleteNoteType,
	};
}

export type NookStore = ReturnType<typeof createNookStore>;
