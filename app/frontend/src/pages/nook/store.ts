import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import {
	parseTypedSearch,
	rankNotesByQuery,
	resolveTypeIdForTerm,
} from "../../noteSearch";
import { createEmbeddedImages } from "./embeddedImages";
import {
	clearLocalDraft,
	deleteServerDraft,
	fetchServerDraft,
	isDraftNewer,
	type NoteDraft,
	putServerDraft,
	readLocalDraft,
	writeLocalDraft,
} from "./noteDraftSync";
import { createNoteTypeActions } from "./noteTypes";
import { createTitleCache } from "./titleCache";
import type {
	AttributeLayout,
	HeadingMatch,
	Mention,
	Note,
	NoteFile,
	NoteHeading,
	NoteHistoryEntry,
	NoteSummary,
	NoteType,
	Panel,
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
	// Title cache (note titles + nook names + resolution + prefetch)
	// lives in ./titleCache.ts. Factory takes the nookId getter so it
	// can default a missing per-lookup nookId to the current one.
	const {
		titleCacheVersion,
		cacheTitles,
		cacheNookName,
		fetchMissingTitles,
		resolveNoteTitle,
		resolveNookName,
		deleteNoteTitle,
		clearNoteTitles,
	} = createTitleCache(nookId);

	let lastDetailRequestId = 0;
	const [nookName, setNookName] = createSignal<string>("");
	const [nookRole, setNookRole] = createSignal<string>("unknown");
	const canWrite = createMemo(() => {
		const role = nookRole();
		return role !== "unknown" && role !== "readonly";
	});
	// Bumps whenever a link is created/deleted anywhere in the UI so that
	// LinkedNotesAttributeField (and other readers) re-fetch their slice
	// without us threading a callback through every consumer.
	const [linksRevision, setLinksRevision] = createSignal(0);
	const bumpLinksRevision = () => setLinksRevision((v) => v + 1);
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
	const [_titleIsManual, setTitleIsManual] = createSignal<boolean>(false);
	const [content, setContent] = createSignal<string>("");
	const [noteAttributes, setNoteAttributes] = createSignal<
		Record<string, unknown>
	>({});
	const [mode, setMode] = createSignal<"view" | "edit">("view");
	const [isDirty, setIsDirty] = createSignal<boolean>(false);

	// Per-user unsaved-edit buffer for the currently open note. Set by
	// applyNoteDetail when it discovers a draft newer than the note's own
	// updated_at (either from sessionStorage or the server GET). The
	// editor surfaces a banner giving the user Restore / Discard.
	const [draftAvailable, setDraftAvailable] = createSignal<NoteDraft | null>(
		null,
	);
	// Latch that flips true once applyNoteDetail has completed for the
	// current note. Autosave gates on this to avoid the classic race
	// where a stale empty (title,content) briefly fires and clobbers the
	// server draft before the fetched detail lands.
	const [draftAutosaveArmed, setDraftAutosaveArmed] = createSignal(false);
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
	const [noteCreatedAt, setNoteCreatedAt] = createSignal<string>("");
	const [noteUpdatedAt, setNoteUpdatedAt] = createSignal<string>("");
	const [noteCreatedByName, setNoteCreatedByName] = createSignal<string>("");
	const [noteHeadings, setNoteHeadings] = createSignal<NoteHeading[]>([]);
	const [noteFiles, setNoteFiles] = createSignal<Record<string, NoteFile>>({});
	const [headingMatches, setHeadingMatches] = createSignal<HeadingMatch[]>([]);
	const [remoteVersion, setRemoteVersion] = createSignal<number>(0);
	const [remoteNoteChanged, setRemoteNoteChanged] =
		createSignal<boolean>(false);
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
						if (v === 0 || v > getTypesVersion()) {
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
		typeId: string;
		attributes: Record<string, unknown>;
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

	// Note-type CRUD lives in ./noteTypes.ts. Signals + setters flow in
	// via the deps bundle so this store keeps ownership of state while
	// the CRUD flow itself is testable in isolation. The `getTypesVersion`
	// getter is what the WS reconnect handler probes to skip stale reloads.
	const {
		loadNoteTypes,
		createNoteType,
		renameNoteType,
		updateNoteType,
		deleteNoteType,
		getTypesVersion,
	} = createNoteTypeActions({
		nookId,
		noteTypes,
		setNoteTypes,
		setLoading,
		setError,
		selectedTypeIds,
		setSelectedTypeIds,
		typeId,
		setTypeId,
	});

	const setTitleFromUser = (next: string) => {
		setTitle(next);
		setTitleIsManual(true);
	};

	const setContentFromUser = (next: string) => {
		setContent(next);
		if (mode() === "edit") setIsDirty(true);
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

	// Embedded image resolver lives in ./embeddedImages.ts. Instantiated
	// after loadNoteDetail so the factory can bind to it — the
	// dependency-injection keeps the module free of store internals.
	const embeddedImages = createEmbeddedImages({
		nookId,
		loadNoteDetail,
	});
	const resolveEmbeddedImageSrc = embeddedImages.resolve;

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
			const files = d.files ?? {};
			const ok = Object.values(files).some(
				(f) =>
					typeof f === "object" &&
					f !== null &&
					String((f as Record<string, unknown>).mime_type ?? "").startsWith(
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
					note: {
						title: string;
						content: string;
						type_id?: string;
						attributes?: Record<string, unknown>;
					};
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
				typeId: s.note.type_id ?? "",
				attributes: s.note.attributes ?? {},
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
		const attrs: (typeof types)[0]["attributes"] = [];
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

	/** Resolve the panel layout for a type, merging inherited layouts from ancestors. */
	const resolveTypeLayout = (typeId: string): Panel[] => {
		const types = noteTypes();
		const typeMap = new Map(types.map((t) => [t.id, t]));

		// Collect layout chain from current type up to root
		const chain: AttributeLayout[] = [];
		const seen = new Set<string>();
		let cur = typeId;
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			const t = typeMap.get(cur);
			if (!t) break;
			chain.push(t.attributeLayout);
			cur = t.parentId;
		}

		// Merge from root down (parent first, child overrides)
		const merged = new Map<string, Panel>();
		for (let i = chain.length - 1; i >= 0; i--) {
			const layout = chain[i];
			if (!layout) continue;
			for (const panel of layout.panels) {
				const existing = merged.get(panel.key);
				if (existing) {
					// Shallow merge: child fields override parent
					merged.set(panel.key, { ...existing, ...panel });
				} else {
					merged.set(panel.key, { ...panel });
				}
			}
		}

		// Filter hidden, collect result
		const panels: Panel[] = [];
		for (const p of merged.values()) {
			if (p.hidden) continue;
			panels.push(p);
		}

		// If no panels defined, return a default main panel
		if (panels.length === 0) {
			return [{ key: "main", position: "main", attributes: [] }];
		}

		return panels;
	};

	const findFileTypeAndAttr = (): { typeId: string; attrId: string } => {
		const types = noteTypes();
		const fileType = types.find((t) => t.key === "file");
		if (!fileType)
			throw new Error('No "File" type found — check your nook type settings');

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
		const ext = filename.includes(".") ? (filename.split(".").pop() ?? "") : "";

		const initRes = await apiFetch(`/api/nooks/${nook}/file/attr-upload-url`, {
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
		});
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
		// Resolved type filter for the API: type:foo text syntax wins, otherwise
		// fall through to the multi-select dropdown. explicitNoType (e.g. "no
		// type:") suppresses any filter.
		const typeIdsForList: string[] = parsed.explicitNoType
			? []
			: typedTypeId !== ""
				? [typedTypeId]
				: [...selected];
		const cursor = reset ? "" : notesNextCursor();
		const q = parsed.textTerm.trim();

		setLoading(true);
		setError("");
		try {
			const qs = new URLSearchParams();
			qs.set("limit", "50");
			if (typeIdsForList.length > 0) {
				qs.set("type_ids", typeIdsForList.join(","));
				qs.set("include_subtypes", "1");
			}
			if (q !== "") qs.set("q", q);
			if (cursor !== "") qs.set("cursor", cursor);
			if (parsed.unlinked) qs.set("unlinked", "1");

			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes?${qs.toString()}`,
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
			const fetched = body.notes;
			const nextNotes = reset ? fetched : [...notes(), ...fetched];
			cacheTitles(fetched.map((n) => ({ id: n.id, title: n.title })));
			setNotes(rankNotesByQuery(nextNotes, q));
			setNotesNextCursor(body.nextCursor);
			if (reset) setHeadingMatches(body.headingMatches);
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
		void loadNoteDetail(id);
	};

	// Internal — actually reset state for a new note. Callers should use
	// `newNote()` which gates on isDirty so unsaved edits aren't silently
	// discarded.
	const newNoteInternal = () => {
		setSelectedId("");
		const ids = selectedTypeIds();
		// Type resolution for new notes:
		//   1. If the user has narrowed the notes list to exactly one type,
		//      inherit that type (matches their obvious intent).
		//   2. Otherwise default to the nook's "base" note type so create
		//      always succeeds without forcing a type decision up front.
		//      The user can still switch via TitleSection's type picker
		//      before pressing Create.
		if (ids.size === 1) {
			setTypeId([...ids][0]);
		} else {
			const base = noteTypes().find((t) => t.key === "base");
			setTypeId(base?.id ?? "");
		}
		// Empty title — force the user to name the note before saving.
		// The Save button in NookToolbar is already disabled on empty
		// title, and TitleSection auto-focuses the input for new notes,
		// so the intent is clear: type a title, then Save.
		setTitle("");
		setTitleIsManual(false);
		setContent("");
		setNoteAttributes({});
		setError("");
		setRemoteNoteChanged(false);
		setMentionTargetId("");
		setMentionEmbedImage(false);
		setMode("edit");
		setIsDirty(false);
		// Drop URL back to the nook root. Without this, if we're currently
		// on /nooks/X/notes/Y the URL→store sync (Nook.tsx) will re-load Y
		// and clobber this fresh draft as soon as its in-flight fetch lands.
		navigatorFn?.("", nookId());
	};

	const newNote = () => {
		// Route through the pendingNav flow when the current buffer has
		// unsaved changes — starting a new note would otherwise silently
		// clobber them. Confirming the dialog then runs newNoteInternal.
		if (isDirty()) {
			setPendingNav({ proceed: () => newNoteInternal() });
			return;
		}
		newNoteInternal();
	};

	const applyNoteDetail = (note: Note) => {
		// Disarm autosave until we've finished writing this note's real
		// values. Otherwise the transient set-to-note-content step below
		// would look like a real edit and get uploaded as a draft.
		setDraftAutosaveArmed(false);
		setDraftAvailable(null);
		setIsDirty(false);
		setRemoteNoteChanged(false);
		setTypeId(String(note.typeId ?? "").trim());
		setTitle(note.title);
		setContent(note.content);

		setNoteAttributes(note.attributes ?? {});
		setTitleIsManual(true);
		setNoteVersion(note.version ?? 0);
		setViewCount(note.viewCount ?? 0);
		setNoteCreatedAt(note.createdAt ?? "");
		setNoteUpdatedAt(note.updatedAt ?? "");
		setNoteCreatedByName(note.createdByName ?? "");
		setNoteHeadings(note.headings ?? []);
		setNoteFiles(note.files ?? {});
		setError("");
		setMentionTargetId("");
		setMentionEmbedImage(false);

		// Now check for a pending draft. sessionStorage first (synchronous,
		// no waiting on the network), server GET in the background — if
		// the server has a newer draft we upgrade the banner to that.
		if (note.id) {
			const local = readLocalDraft(note.id);
			if (local && isDraftNewer(local.updatedAt, note.updatedAt ?? "")) {
				setDraftAvailable(local);
			}
			// Fire-and-forget server check — the AI or another tab may have
			// written a draft this session doesn't know about.
			void fetchServerDraft(nookId(), note.id).then((res) => {
				if (!res?.draft) return;
				// Only replace the banner if this note is still selected —
				// user may have navigated away in the meantime.
				if (selectedId() !== note.id) return;
				const currentBanner = draftAvailable();
				const serverIsNewer = isDraftNewer(
					res.draft.updatedAt,
					currentBanner?.updatedAt ?? note.updatedAt ?? "",
				);
				if (serverIsNewer) setDraftAvailable(res.draft);
			});
		}

		// Arm on the next microtask so this same batch of setters doesn't
		// fire the autosave effect. queueMicrotask flushes after Solid's
		// current update cycle, which is enough.
		queueMicrotask(() => setDraftAutosaveArmed(true));
	};

	const selectNoteInternal = (note: NoteSummary) => {
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
		void loadNoteDetail(note.id);
	};

	const selectNote = (note: NoteSummary) => {
		// Same rationale as newNote / quickUploadFile — switching notes
		// while dirty should prompt, never silently drop unsaved work.
		if (isDirty()) {
			setPendingNav({ proceed: () => selectNoteInternal(note) });
			return;
		}
		selectNoteInternal(note);
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

	/** Load a note by ID into the store (called by URL→store sync). The
	 * optional isStillValid guard lets the caller cancel a stale load —
	 * e.g. the user navigated away (or clicked New note) while the fetch
	 * was in flight; without it the eventual selectNote clobbers the new
	 * draft. */
	const loadNoteById = async (noteId: string, isStillValid?: () => boolean) => {
		const stillValid = () => (isStillValid ? isStillValid() : true);
		const found = notes().find((n) => n.id === noteId);
		if (found) {
			if (stillValid()) selectNote(found);
			return;
		}
		// Note not in current list — fetch it directly instead of reloading
		// the full list (which races with the reactive loadNotes effect).
		const detail = await loadNoteDetail(noteId);
		if (!stillValid()) return;
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
		const cached = resolveNoteTitle(targetId);
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

	// ─── Draft autosave ──────────────────────────────────────────────
	// Two debounced writers with different cadences. Recovery loss is
	// bounded by whichever tier is fresher, so we tolerate a fairly
	// quiet server cadence.
	//
	//   local  — 10s   sessionStorage (per-tab, cheap, cleared on close)
	//   server — 60s   note_drafts row (per-user, survives disconnect)
	//
	// visibilitychange flushes both immediately so a tab close within
	// the debounce window still captures the latest state.
	let draftLocalTimer: number | null = null;
	let draftServerTimer: number | null = null;
	// Latest (t, c) captured while a debounce is pending. Solid tracks
	// signal reads inside effects, but the timeout callback runs later
	// where those tracked reads no longer apply — so we snapshot here.
	let pendingDraft: {
		id: string;
		nookId: string;
		t: string;
		c: string;
	} | null = null;
	const DRAFT_LOCAL_DEBOUNCE_MS = 10_000;
	const DRAFT_SERVER_DEBOUNCE_MS = 60_000;

	const flushLocalDraft = () => {
		if (draftLocalTimer !== null) {
			window.clearTimeout(draftLocalTimer);
			draftLocalTimer = null;
		}
		if (!pendingDraft) return;
		writeLocalDraft(pendingDraft.id, {
			noteId: pendingDraft.id,
			title: pendingDraft.t,
			content: pendingDraft.c,
			version: 0,
			updatedAt: new Date().toISOString(),
		});
	};

	const flushServerDraft = () => {
		if (draftServerTimer !== null) {
			window.clearTimeout(draftServerTimer);
			draftServerTimer = null;
		}
		if (!pendingDraft) return;
		void putServerDraft(
			pendingDraft.nookId,
			pendingDraft.id,
			pendingDraft.t,
			pendingDraft.c,
		);
	};

	// Global tab-visibility hook: user is about to leave / minimize.
	// Best chance to persist unsaved work before the tab is gone.
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				flushLocalDraft();
				flushServerDraft();
			}
		});
	}

	createEffect(() => {
		if (!draftAutosaveArmed()) return;
		if (!isEditing()) return;
		const id = selectedId();
		if (!id) return;

		// Read title/content — Solid tracks these reads so the effect
		// re-fires on any change.
		const t = title();
		const c = content();

		// Only autosave once the note has diverged from its saved state.
		// Otherwise every reload would upload a "draft" that matches the
		// server and add noise.
		if (!isDirty()) return;

		pendingDraft = { id, nookId: nookId(), t, c };

		if (draftLocalTimer !== null) window.clearTimeout(draftLocalTimer);
		draftLocalTimer = window.setTimeout(() => {
			draftLocalTimer = null;
			flushLocalDraft();
		}, DRAFT_LOCAL_DEBOUNCE_MS);

		if (draftServerTimer !== null) window.clearTimeout(draftServerTimer);
		draftServerTimer = window.setTimeout(() => {
			draftServerTimer = null;
			flushServerDraft();
		}, DRAFT_SERVER_DEBOUNCE_MS);
	});

	/**
	 * Surgical find-and-replace against the live editor buffer. Matches
	 * the shape of the server-side edit_note endpoint but stays entirely
	 * in-browser — the AI's edit lands in the same buffer the user is
	 * typing into, and autosave will pick it up on the next debounce
	 * tick. Returns the result the AI needs to see as its tool_result.
	 *
	 * Requires isEditing() — a view-mode edit would surprise the user by
	 * silently mutating a note they thought was static.
	 */
	const editCurrentEditor = (
		find: string,
		replace: string,
	): { applied: boolean; error?: string; newContent?: string } => {
		if (!isEditing()) {
			return { applied: false, error: "editor is not in edit mode" };
		}
		const current = content();
		const first = current.indexOf(find);
		if (first === -1) return { applied: false, error: "not_found" };
		const second = current.indexOf(find, first + find.length);
		if (second !== -1) return { applied: false, error: "ambiguous" };
		const next =
			current.slice(0, first) + replace + current.slice(first + find.length);
		setContentFromUser(next);
		return { applied: true, newContent: next };
	};

	const applyDraft = () => {
		const d = draftAvailable();
		if (!d) return;
		batch(() => {
			setTitle(d.title);
			setContent(d.content);
			setIsDirty(true);
			setDraftAvailable(null);
		});
	};

	const discardDraft = () => {
		const id = selectedId();
		setDraftAvailable(null);
		if (!id) return;
		// Any in-flight debounce also becomes stale — don't let a flush
		// resurrect the discarded content a few seconds after clear.
		if (draftLocalTimer !== null) window.clearTimeout(draftLocalTimer);
		if (draftServerTimer !== null) window.clearTimeout(draftServerTimer);
		draftLocalTimer = null;
		draftServerTimer = null;
		pendingDraft = null;
		clearLocalDraft(id);
		void deleteServerDraft(nookId(), id);
	};

	const saveNote = async () => {
		setConflictError(null);
		if (!isEditing()) return;
		const titleForSave = title().trim();
		if (titleForSave === "") {
			setError("Title is required");
			return;
		}

		// Validate attribute values before saving
		const currentTypeId = typeId();
		if (currentTypeId) {
			const attrs = resolveTypeAttributes(currentTypeId);
			const vals = noteAttributes();
			const { validateNoteAttributes } = await import("./attributeValidation");
			const errors = validateNoteAttributes(attrs, vals);
			if (errors.length > 0) {
				setError(errors.join("; "));
				return;
			}
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
				// Save succeeded — any pending draft on the *new* id shouldn't
				// persist. (New-note drafts before save use the empty id as
				// key; nothing to clear locally, but the server-side has no
				// draft yet either.)
				// Save landed on disk — kill any in-flight debounce so the
				// timer doesn't fire a moment later and re-upload the same
				// content as a "draft" that's now identical to the note.
				if (draftLocalTimer !== null) window.clearTimeout(draftLocalTimer);
				if (draftServerTimer !== null) window.clearTimeout(draftServerTimer);
				draftLocalTimer = null;
				draftServerTimer = null;
				pendingDraft = null;
				clearLocalDraft(body.note.id);
				void deleteServerDraft(nookId(), body.note.id);
				await loadMentions();
				void loadHistory();
				// Sync URL with the just-created id so refresh keeps the
				// note open and any later URL→store re-runs match. Without
				// this we left the URL on /nooks/X (where New note had
				// dropped it) while the store held the new id.
				onNoteLinkClickInternal(body.note.id);
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
				// Save landed on disk — kill any in-flight debounce so the
				// timer doesn't fire a moment later and re-upload the same
				// content as a "draft" that's now identical to the note.
				if (draftLocalTimer !== null) window.clearTimeout(draftLocalTimer);
				if (draftServerTimer !== null) window.clearTimeout(draftServerTimer);
				draftLocalTimer = null;
				draftServerTimer = null;
				pendingDraft = null;
				clearLocalDraft(body.note.id);
				void deleteServerDraft(nookId(), body.note.id);
				// PUT response is lean — no `files`, `headings`, etc. (see
				// NotesController::update). Refetch via the full GET so
				// embedded images, TOC and similar keep rendering after save.
				void loadNoteDetail(body.note.id);
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

			deleteNoteTitle(id);
			embeddedImages.delete(id);
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
			clearNoteTitles();
			embeddedImages.clear();
		}
	});

	// (Previously: eager createEffect that called loadNotes on every
	// nookId / selectedTypeIds / notesQuery change. Removed because
	// the only consumer was the global notes-search dropdown, which
	// now lazy-fetches its own lean titles list on focus via the
	// /notes/titles endpoint. loadNotes stays available for callers
	// that explicitly want the full notes list — e.g. NookUnlinkedNotes
	// has its own state and never used this effect.)

	const uploadFile = async (_file: File) => {};

	const quickUploadFileInternal = async (file: File) => {
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

	const quickUploadFile = async (file: File) => {
		// If there are unsaved edits in the current note, prompt before
		// starting the upload — otherwise the post-upload navigation would
		// silently discard them. Save/Discard on the dialog runs the upload;
		// Cancel aborts.
		if (isDirty()) {
			setPendingNav({ proceed: () => void quickUploadFileInternal(file) });
			return;
		}
		await quickUploadFileInternal(file);
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
		linksRevision,
		bumpLinksRevision,
		setNotesQuery: (next: string) => setNotesQuery(String(next ?? "")),
		setTypeId: (next: string) => setTypeId(next.trim()),
		loadNotes,
		loadMoreNotes,
		refreshCurrentNote,
		loadMentions,
		noteHeadings,
		noteFiles,
		headingMatches,
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
		noteCreatedAt,
		noteUpdatedAt,
		noteCreatedByName,
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
		resolveNoteTitle,
		resolveNookName,
		resolveEmbeddedImageSrc,
		uploadEmbeddedImage,
		saveNote,
		deleteNote,
		draftAvailable,
		applyDraft,
		discardDraft,
		editCurrentEditor,
		noteAttributes,
		setNoteAttribute,
		loadDetail,
		uploadFile,
		quickUploadFile,
		downloadFile,
		resolveTypeAttributes,
		resolveTypeLayout,
		createNoteType,
		renameNoteType,
		updateNoteType,
		deleteNoteType,
	};
}

export type NookStore = ReturnType<typeof createNookStore>;
