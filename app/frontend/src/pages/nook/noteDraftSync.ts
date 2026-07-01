import { apiFetch } from "../../auth/keycloak";

/**
 * Per-user unsaved-edit buffer for a note. Two-tier persistence:
 *
 * 1. sessionStorage — synchronous, per-tab, cleared on browser close.
 *    Written on every keystroke so a page refresh mid-edit doesn't lose
 *    the buffer. Session-scoped (not localStorage) so a shared machine
 *    doesn't leak drafts to whoever opens the tab next.
 *
 * 2. Server (POST /api/nooks/{nookId}/notes/{noteId}/draft) — debounced
 *    every ~1.5s while the editor is active. Survives disconnect and
 *    device switches. On note-open we compare draft.updated_at against
 *    the note's own updated_at and surface a recovery banner if the
 *    draft is newer than the last save.
 *
 * Both tiers are cleared when the user saves the note or explicitly
 * discards the draft.
 */

export type NoteDraft = {
	noteId: string;
	title: string;
	content: string;
	version: number;
	updatedAt: string; // ISO 8601, from the server on success; from Date on local writes
};

/**
 * Server response shape from GET /draft. `noteUpdatedAt` is the note's
 * saved timestamp — comparing draft.updatedAt to it is how the banner
 * decides whether to surface "you have a draft".
 */
export type ServerDraftResponse = {
	draft: NoteDraft | null;
	noteUpdatedAt: string;
};

// Bump when the sessionStorage shape changes so we don't try to load
// old-shape entries as new-shape objects.
const SS_VERSION = 1;
const ssKey = (noteId: string) => `note_draft:v${SS_VERSION}:${noteId}`;

export function readLocalDraft(noteId: string): NoteDraft | null {
	try {
		const raw = sessionStorage.getItem(ssKey(noteId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as NoteDraft;
		// Basic shape check — the store may be older or corrupted.
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.content !== "string" ||
			typeof parsed.title !== "string" ||
			typeof parsed.updatedAt !== "string"
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function writeLocalDraft(noteId: string, draft: NoteDraft): void {
	try {
		sessionStorage.setItem(ssKey(noteId), JSON.stringify(draft));
	} catch {
		// QuotaExceeded on a giant paste — best-effort, server tier is
		// the durable one anyway.
	}
}

export function clearLocalDraft(noteId: string): void {
	try {
		sessionStorage.removeItem(ssKey(noteId));
	} catch {
		// nothing sensible to do
	}
}

export async function fetchServerDraft(
	nookId: string,
	noteId: string,
): Promise<ServerDraftResponse | null> {
	try {
		const res = await apiFetch(
			`/api/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/draft`,
			{ method: "GET" },
		);
		if (!res.ok) return null;
		const body = (await res.json()) as {
			draft: unknown;
			note_updated_at: string;
		};
		const rawDraft = body.draft as Record<string, unknown> | null;
		const draft: NoteDraft | null =
			rawDraft && typeof rawDraft === "object"
				? {
						noteId: String(rawDraft.note_id ?? noteId),
						title: String(rawDraft.title ?? ""),
						content: String(rawDraft.content ?? ""),
						version: Number(rawDraft.version ?? 0),
						updatedAt: String(rawDraft.updated_at ?? ""),
					}
				: null;
		return { draft, noteUpdatedAt: String(body.note_updated_at ?? "") };
	} catch {
		return null;
	}
}

export async function putServerDraft(
	nookId: string,
	noteId: string,
	title: string,
	content: string,
): Promise<{ version: number; updatedAt: string } | null> {
	try {
		const res = await apiFetch(
			`/api/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/draft`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, content }),
			},
		);
		if (!res.ok) return null;
		const body = (await res.json()) as { version: number; updated_at: string };
		return {
			version: Number(body.version ?? 0),
			updatedAt: String(body.updated_at ?? ""),
		};
	} catch {
		return null;
	}
}

export async function deleteServerDraft(
	nookId: string,
	noteId: string,
): Promise<void> {
	try {
		await apiFetch(
			`/api/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/draft`,
			{ method: "DELETE" },
		);
	} catch {
		// best-effort — draft eventually expires or overwrites
	}
}

/**
 * Decide whether a draft (local or server) is newer than the note's
 * own saved state. The banner should only appear when the draft
 * represents work that wasn't captured by the last save.
 *
 * Timestamps compared as ISO 8601 strings — lexicographic order
 * matches chronological order for that format.
 */
export function isDraftNewer(
	draftUpdatedAt: string,
	noteUpdatedAt: string,
): boolean {
	if (draftUpdatedAt === "") return false;
	if (noteUpdatedAt === "") return true;
	return draftUpdatedAt > noteUpdatedAt;
}
