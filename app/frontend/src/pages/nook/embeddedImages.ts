import { apiFetch } from "../../auth/keycloak";
import { type Note, NoteResponseSchema } from "./types";

/**
 * Resolver + cache for images embedded in note content (via
 * `![alt](note:UUID)` or the cross-nook `note:nookId/noteId` variant).
 *
 * The AI can generate images in the AI-memory nook and reference them
 * from a note in another nook, so this resolver has to reach across
 * nooks. It skips the store's `loadNoteDetail` for cross-nook loads —
 * that function mutates current-note state on success.
 *
 * `resolve()` returns:
 *   - a HMAC-signed URL for `/files/<key>` when the API included one
 *     (nginx verifies in-process, no PHP round-trip per render, 2hr
 *     cache TTL). Preferred path.
 *   - the unsigned `/files/<key>?inline=1` fallback for older API
 *     responses that didn't ship a signed url yet.
 *   - null if the referenced note has no image file or the fetch failed.
 *
 * Callers are the markdown renderer and the chat rendered-image
 * surfaces. Deletion + clearing happen from the store when a note is
 * removed or the current nook changes.
 */
export type EmbeddedImages = {
	resolve: (noteId: string, embedNookId?: string) => Promise<string | null>;
	delete: (id: string) => void;
	clear: () => void;
};

export type EmbeddedImagesDeps = {
	nookId: () => string;
	/**
	 * Same-nook detail loader from the store — mutates current-note
	 * state, so we only use it when the target lives in the current
	 * nook (that's where its side-effects are wanted). Cross-nook
	 * loads go through a dedicated helper below that reads and returns
	 * without touching store state.
	 */
	loadNoteDetail: (id: string) => Promise<Note | null>;
};

export function createEmbeddedImages(deps: EmbeddedImagesDeps): EmbeddedImages {
	// Cache is keyed by "nookId:noteId" so cross-nook and same-nook
	// entries can coexist (a note id can technically appear in more
	// than one nook the user has access to).
	const cache = new Map<string, string>();

	// Cross-nook detail loader — same shape as the store's, but
	// deliberately does NOT touch the store. Used only when the embed
	// resolves to a different nook than the currently-open one.
	const fetchNoteFromNook = async (
		noteId: string,
		targetNookId: string,
	): Promise<Note | null> => {
		try {
			const res = await apiFetch(`/api/nooks/${targetNookId}/notes/${noteId}`, {
				method: "GET",
			});
			if (!res.ok) return null;
			const json = await res.json();
			return NoteResponseSchema.parse(json).note;
		} catch {
			return null;
		}
	};

	const resolve = async (
		noteId: string,
		embedNookId?: string,
	): Promise<string | null> => {
		const id = noteId.trim();
		const currentNook = deps.nookId();
		const targetNook = embedNookId?.trim() || currentNook;
		if (id === "" || targetNook === "") return null;
		const cacheKey = `${targetNook}:${id}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		const d =
			targetNook === currentNook
				? await deps.loadNoteDetail(id)
				: await fetchNoteFromNook(id, targetNook);
		if (!d) return null;

		// Find the first file with an image mime type. Prefer the
		// server-signed URL (HMAC verified in nginx, no PHP roundtrip
		// per render, 2hr cache TTL); fall back to the legacy unsigned
		// /files/<object_key> path only if the backend didn't include
		// one (older API response, no session cookie issued the URL, etc.).
		const files = d.files ?? {};
		let imageFile: { object_key: string; signed_url?: string } | null = null;
		for (const f of Object.values(files)) {
			if (typeof f === "object" && f !== null && "mime_type" in f) {
				const ct = String((f as Record<string, unknown>).mime_type ?? "");
				if (ct.startsWith("image/")) {
					const rec = f as Record<string, unknown>;
					const signed =
						typeof rec.signed_url === "string" ? rec.signed_url : "";
					imageFile = {
						object_key: String(rec.object_key ?? ""),
						signed_url: signed || undefined,
					};
					break;
				}
			}
		}
		if (!imageFile?.object_key) return null;

		const url =
			imageFile.signed_url ?? `/files/${imageFile.object_key}?inline=1`;
		cache.set(cacheKey, url);
		return url;
	};

	return {
		resolve,
		delete: (id) => {
			// Cache is keyed by "nook:note" but we don't know the nook
			// here — this delete is called after a note delete, and
			// stale entries with an ID that no longer exists are harmless.
			// Best-effort scan-and-delete matches on the id suffix.
			for (const key of cache.keys()) {
				if (key.endsWith(`:${id}`)) cache.delete(key);
			}
		},
		clear: () => cache.clear(),
	};
}
