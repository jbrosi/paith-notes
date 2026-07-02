import { createSignal } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { NoteResponseSchema } from "./types";

/**
 * Two-tier title cache extracted from the nook store.
 *
 * - noteTitleCache: `nook:note` → title. Populated by every list/search
 *   fetch and by ad-hoc fetches for cross-nook mentions the AI writes.
 * - nookTitleCache: nook id → nook name. Populated by loading the
 *   AI-memory nook and by cross-nook click paths.
 *
 * `titleCacheVersion` is bumped on any change so reactive readers (link
 * renderers, mention lists, etc.) re-render when a resolution lands.
 *
 * `fetchMissingTitles` deduplicates in-flight requests so N mentions
 * to the same note don't fire N parallel GETs.
 */

export type TitleCache = {
	titleCacheVersion: () => number;
	cacheTitles: (
		entries: Array<{ id: string; title: string }>,
		forNookId?: string,
	) => void;
	cacheNookName: (id: string, name: string) => void;
	fetchMissingTitles: (refs: Array<{ nookId: string; noteId: string }>) => void;
	resolveNoteTitle: (id: string, forNookId?: string) => string | undefined;
	resolveNookName: (id: string) => string | undefined;
	/** Drop a single note's cached title — used on note delete. */
	deleteNoteTitle: (id: string, forNookId?: string) => void;
	/** Nuke the note-title map — used on nook change. Nook-name map is
	 *  preserved because those cross nooks. */
	clearNoteTitles: () => void;
};

export function createTitleCache(currentNookId: () => string): TitleCache {
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
		const nook = forNookId ?? currentNookId();
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
			const targetNook = r.nookId || currentNookId();
			const key = titleKey(targetNook, r.noteId);
			return (
				r.noteId !== "" &&
				!noteTitleCache.has(key) &&
				!titleFetchInFlight.has(key)
			);
		});
		if (missing.length === 0) return;
		for (const r of missing)
			titleFetchInFlight.add(titleKey(r.nookId || currentNookId(), r.noteId));
		void Promise.all(
			missing.map(async (r) => {
				const targetNook = r.nookId || currentNookId();
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

	const resolveNoteTitle = (
		id: string,
		forNookId?: string,
	): string | undefined => {
		// Track the version signal so callers subscribed via createEffect
		// / createMemo re-run when the cache changes.
		void titleCacheVersion();
		return noteTitleCache.get(titleKey(forNookId ?? currentNookId(), id));
	};

	const resolveNookName = (id: string): string | undefined => {
		void titleCacheVersion();
		return nookTitleCache.get(id);
	};

	const deleteNoteTitle = (id: string, forNookId?: string): void => {
		const nook = forNookId ?? currentNookId();
		if (noteTitleCache.delete(titleKey(nook, id))) bumpTitleCache();
	};

	const clearNoteTitles = (): void => {
		if (noteTitleCache.size === 0) return;
		noteTitleCache.clear();
		bumpTitleCache();
	};

	return {
		titleCacheVersion,
		cacheTitles,
		cacheNookName,
		fetchMissingTitles,
		resolveNoteTitle,
		resolveNookName,
		deleteNoteTitle,
		clearNoteTitles,
	};
}
