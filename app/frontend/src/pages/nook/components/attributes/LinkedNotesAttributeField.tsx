import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../../auth/keycloak";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

export type LinkedNoteItem = {
	noteId: string;
	noteTitle: string;
	nookId?: string;
	typeId?: string;
	predicateLabel?: string;
};

export function LinkedNotesAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
}) {
	const [links, setLinks] = createSignal<
		Array<{
			noteId: string;
			noteTitle: string;
			typeId: string;
			predicateId: string;
			predicateLabel: string;
			direction: "outgoing" | "incoming";
		}>
	>([]);

	const config = () => {
		const c = props.attr.config;
		return {
			direction: String(c.direction ?? "both") as "outgoing" | "incoming" | "both",
			filterTypeIds: Array.isArray(c.filter_type_ids) ? (c.filter_type_ids as string[]) : [],
			filterPredicateIds: Array.isArray(c.filter_predicate_ids) ? (c.filter_predicate_ids as string[]) : [],
			sort: String(c.sort ?? "title") as "title" | "created" | "updated",
			display: String(c.display ?? "list"),
		};
	};

	// Fetch links when note changes
	createEffect(() => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId) {
			setLinks([]);
			return;
		}
		void (async () => {
			try {
				const res = await apiFetch(
					`/api/nooks/${nookId}/notes/${noteId}/links?direction=both&depth=1`,
				);
				if (!res.ok) return;
				const body = (await res.json()) as {
					links?: Array<{
						source_note_id: string;
						source_note_title?: string;
						source_type_id?: string;
						target_note_id: string;
						target_note_title?: string;
						target_type_id?: string;
						forward_label?: string;
						reverse_label?: string;
						predicate_id?: string;
					}>;
				};
				const result: typeof links extends () => infer T ? T : never = [];
				for (const l of body.links ?? []) {
					if (l.source_note_id === noteId) {
						result.push({
							noteId: l.target_note_id,
							noteTitle: l.target_note_title ?? "",
							typeId: l.target_type_id ?? "",
							predicateId: l.predicate_id ?? "",
							predicateLabel: l.forward_label ?? "",
							direction: "outgoing",
						});
					} else {
						result.push({
							noteId: l.source_note_id,
							noteTitle: l.source_note_title ?? "",
							typeId: l.source_type_id ?? "",
							predicateId: l.predicate_id ?? "",
							predicateLabel: l.reverse_label ?? "",
							direction: "incoming",
						});
					}
				}
				setLinks(result);
			} catch {
				setLinks([]);
			}
		})();
	});

	const items = createMemo((): LinkedNoteItem[] => {
		const cfg = config();
		const noteId = props.store.selectedId();
		if (!noteId) return [];

		const result: LinkedNoteItem[] = [];
		const seen = new Set<string>();

		const addItem = (item: LinkedNoteItem) => {
			if (seen.has(item.noteId) || item.noteId === noteId) return;
			if (cfg.filterTypeIds.length > 0 && item.typeId && !cfg.filterTypeIds.includes(item.typeId)) return;
			seen.add(item.noteId);
			result.push(item);
		};

		// Links (from API)
		for (const l of links()) {
			if (cfg.direction !== "both" && l.direction !== cfg.direction) continue;
			if (cfg.filterPredicateIds.length > 0 && !cfg.filterPredicateIds.includes(l.predicateId)) continue;
			addItem({
				noteId: l.noteId,
				noteTitle: l.noteTitle,
				typeId: l.typeId,
				predicateLabel: l.predicateLabel,
			});
		}

		// Sort
		if (cfg.sort === "title") {
			result.sort((a, b) => a.noteTitle.localeCompare(b.noteTitle));
		}

		return result;
	});

	return (
		<Show when={items().length > 0}>
			<div style={{ "margin-top": "8px" }}>
				<div
					style={{
						"font-size": "0.7rem",
						"font-weight": "600",
						color: "var(--color-text-secondary)",
						"margin-bottom": "4px",
						"text-transform": "uppercase",
						"letter-spacing": "0.03em",
					}}
				>
					{props.attr.name}
				</div>
				<div style={{ display: "grid", gap: "2px" }}>
					<For each={items()}>
						{(item) => (
							<button
								type="button"
								onClick={() => props.store.onNoteLinkClick(item.noteId, item.nookId)}
								style={{
									display: "block",
									width: "100%",
									padding: "4px 8px",
									border: "1px solid var(--color-border-light, #e5e7eb)",
									"border-radius": "4px",
									background: "none",
									"text-align": "left",
									cursor: "pointer",
									"font-size": "0.8rem",
									color: "var(--link-color, #0066cc)",
								}}
							>
								{item.noteTitle || "(untitled)"}
								<Show when={item.predicateLabel}>
									<span style={{ color: "var(--color-text-muted)", "margin-left": "6px", "font-size": "0.7rem" }}>
										{item.predicateLabel}
									</span>
								</Show>
							</button>
						)}
					</For>
				</div>
			</div>
		</Show>
	);
}
