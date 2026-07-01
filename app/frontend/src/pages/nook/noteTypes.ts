import { apiFetch } from "../../auth/keycloak";
import type { NoteType } from "./types";
import { NoteTypeResponseSchema, NoteTypesListResponseSchema } from "./types";

/**
 * Note-type CRUD extracted from the store. Kept as a factory so it can
 * close over the store's internal setters (setNoteTypes, setLoading,
 * setError, etc.) without needing a full reactive framework rewrite.
 *
 * `typesVersion` is tracked internally and returned via `getTypesVersion()`
 * — the WS reconnect handler uses it to decide whether an incoming
 * `types_changed` event has already been applied.
 *
 * All operations gate on nookId() to avoid firing during a route
 * transition where the current nook is momentarily empty.
 */

export type NoteTypeDeps = {
	nookId: () => string;
	noteTypes: () => NoteType[];
	setNoteTypes: (next: NoteType[]) => void;
	setLoading: (next: boolean) => void;
	setError: (next: string) => void;
	selectedTypeIds: () => Set<string>;
	setSelectedTypeIds: (next: Set<string>) => void;
	typeId: () => string;
	setTypeId: (next: string) => void;
};

export type NoteTypeActions = {
	loadNoteTypes: () => Promise<void>;
	createNoteType: (input: {
		key: string;
		label: string;
		parentId: string;
	}) => Promise<NoteType | null>;
	renameNoteType: (type: NoteType, nextLabel: string) => Promise<void>;
	updateNoteType: (
		type: NoteType,
		next: {
			key: string;
			label: string;
			description: string;
			parentId: string;
		},
	) => Promise<NoteType | null>;
	deleteNoteType: (type: NoteType) => Promise<void>;
	getTypesVersion: () => number;
};

export function createNoteTypeActions(deps: NoteTypeDeps): NoteTypeActions {
	// Bumped by every list load; the WS `types_changed` event carries a
	// version so we can skip stale-cache reloads when we already fetched
	// the same-or-newer state.
	let typesVersion = 0;

	const loadNoteTypes = async () => {
		if (deps.nookId() === "") return;
		try {
			const res = await apiFetch(`/api/nooks/${deps.nookId()}/note-types`, {
				method: "GET",
			});
			if (res.status === 401) {
				if (deps.noteTypes().length > 0) deps.setNoteTypes([]);
				return;
			}
			if (!res.ok) {
				throw new Error(
					`Failed to load note types: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteTypesListResponseSchema.parse(json);
			deps.setNoteTypes(body.types);
			typesVersion = body.version;
		} catch (e) {
			deps.setNoteTypes([]);
			deps.setError(String(e));
		}
	};

	const createNoteType = async (input: {
		key: string;
		label: string;
		parentId: string;
	}): Promise<NoteType | null> => {
		if (deps.nookId() === "") return null;
		const key = input.key.trim();
		const label = input.label.trim();
		if (key === "" || label === "") {
			deps.setError("Key and label are required");
			return null;
		}

		const parentId = input.parentId.trim();

		deps.setLoading(true);
		deps.setError("");
		try {
			const res = await apiFetch(`/api/nooks/${deps.nookId()}/note-types`, {
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
			deps.setError(String(e));
			return null;
		} finally {
			deps.setLoading(false);
		}
	};

	const renameNoteType = async (type: NoteType, nextLabel: string) => {
		if (deps.nookId() === "") return;
		const label = nextLabel.trim();
		if (label === "") {
			deps.setError("Label is required");
			return;
		}
		deps.setLoading(true);
		deps.setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${deps.nookId()}/note-types/${type.id}`,
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
			deps.setError(String(e));
		} finally {
			deps.setLoading(false);
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
		if (deps.nookId() === "") return null;
		const key = next.key.trim();
		const label = next.label.trim();
		if (key === "" || label === "") {
			deps.setError("Key and label are required");
			return null;
		}
		deps.setLoading(true);
		deps.setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${deps.nookId()}/note-types/${type.id}`,
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
			deps.setError(String(e));
			return null;
		} finally {
			deps.setLoading(false);
		}
	};

	const deleteNoteType = async (type: NoteType) => {
		if (deps.nookId() === "") return;
		deps.setLoading(true);
		deps.setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${deps.nookId()}/note-types/${type.id}`,
				{ method: "DELETE" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to delete type: ${res.status} ${res.statusText}`,
				);
			}
			await loadNoteTypes();
			if (deps.selectedTypeIds().has(type.id)) {
				const next = new Set(deps.selectedTypeIds());
				next.delete(type.id);
				deps.setSelectedTypeIds(next);
			}
			if (deps.typeId() === type.id) {
				deps.setTypeId("");
			}
		} catch (e) {
			deps.setError(String(e));
		} finally {
			deps.setLoading(false);
		}
	};

	return {
		loadNoteTypes,
		createNoteType,
		renameNoteType,
		updateNoteType,
		deleteNoteType,
		getTypesVersion: () => typesVersion,
	};
}
