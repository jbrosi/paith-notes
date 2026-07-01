import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../../auth/keycloak";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";
import { AddLinkForm } from "../AddLinkForm";
import { FullscreenButton } from "./FullscreenButton";

export type LinkedNoteItem = {
	/**
	 * ID of the underlying note_link row. Optional because some virtual
	 * items (mentions, cross-nook incoming refs) don't come from that
	 * table and can't be deleted here — the UI hides the unlink button
	 * for items without an id.
	 */
	linkId?: string;
	noteId: string;
	noteTitle: string;
	nookId?: string;
	typeId?: string;
	predicateLabel?: string;
};

export function LinkedNotesAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	fullscreen?: boolean;
}) {
	const [links, setLinks] = createSignal<
		Array<{
			linkId: string;
			noteId: string;
			noteTitle: string;
			typeId: string;
			predicateId: string;
			predicateLabel: string;
			direction: "outgoing" | "incoming";
		}>
	>([]);
	const [showAddForm, setShowAddForm] = createSignal(false);
	const [addError, setAddError] = createSignal("");

	const config = () => {
		const c = props.attr.config;
		return {
			direction: String(c.direction ?? "both") as
				| "outgoing"
				| "incoming"
				| "both",
			filterTypeIds: Array.isArray(c.filter_type_ids)
				? (c.filter_type_ids as string[])
				: [],
			filterPredicateIds: Array.isArray(c.filter_predicate_ids)
				? (c.filter_predicate_ids as string[])
				: [],
			sort: String(c.sort ?? "title") as "title" | "created" | "updated",
			display: String(c.display ?? "list"),
		};
	};

	const loadLinks = async () => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId) {
			setLinks([]);
			return;
		}
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId}/notes/${noteId}/links?direction=both&depth=1`,
			);
			if (!res.ok) return;
			const body = (await res.json()) as {
				links?: Array<{
					id: string;
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
						linkId: l.id,
						noteId: l.target_note_id,
						noteTitle: l.target_note_title ?? "",
						typeId: l.target_type_id ?? "",
						predicateId: l.predicate_id ?? "",
						predicateLabel: l.forward_label ?? "",
						direction: "outgoing",
					});
				} else {
					result.push({
						linkId: l.id,
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
	};

	createEffect(() => {
		// Re-fetch when the selected note changes, or when any link is
		// created/deleted elsewhere (e.g. the toolbar add-link form).
		void props.store.linksRevision();
		void loadLinks();
	});

	createEffect(() => {
		// Reset the inline add form when the user navigates to a different note.
		void props.store.selectedId();
		setShowAddForm(false);
		setAddError("");
	});

	/**
	 * Delete a note_link. Confirms first — the button sits right next
	 * to the link tap target and a stray tap on mobile should never
	 * silently remove a relationship.
	 */
	const deleteLink = async (linkId: string, title: string) => {
		if (!window.confirm(`Remove link to "${title || "(untitled)"}"?`)) return;
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId) return;
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/links/${encodeURIComponent(linkId)}`,
				{ method: "DELETE" },
			);
			if (res.ok) {
				props.store.bumpLinksRevision();
			}
		} catch {
			// best-effort — user can retry
		}
	};

	const items = createMemo((): LinkedNoteItem[] => {
		const cfg = config();
		const noteId = props.store.selectedId();
		if (!noteId) return [];

		const result: LinkedNoteItem[] = [];
		const seen = new Set<string>();

		const addItem = (item: LinkedNoteItem) => {
			if (seen.has(item.noteId) || item.noteId === noteId) return;
			if (
				cfg.filterTypeIds.length > 0 &&
				item.typeId &&
				!cfg.filterTypeIds.includes(item.typeId)
			)
				return;
			seen.add(item.noteId);
			result.push(item);
		};

		// Links (from API)
		for (const l of links()) {
			if (cfg.direction !== "both" && l.direction !== cfg.direction) continue;
			if (
				cfg.filterPredicateIds.length > 0 &&
				!cfg.filterPredicateIds.includes(l.predicateId)
			)
				continue;
			addItem({
				linkId: l.linkId,
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
		<div style={{ "margin-top": "8px" }}>
			<div
				style={{
					"font-size": "0.7rem",
					"font-weight": "600",
					color: "var(--color-text-secondary)",
					"margin-bottom": "4px",
					"text-transform": "uppercase",
					"letter-spacing": "0.03em",
					display: "flex",
					"align-items": "center",
					gap: "6px",
				}}
			>
				{props.attr.name}
				<Show when={!props.fullscreen}>
					<FullscreenButton attr={props.attr} store={props.store} />
				</Show>
				<Show when={props.store.canWrite() && props.store.selectedId() !== ""}>
					<button
						type="button"
						onClick={() => setShowAddForm((v) => !v)}
						style={{
							background: "none",
							border: "none",
							color: "var(--link-color, #0066cc)",
							cursor: "pointer",
							"font-size": "0.7rem",
							padding: "0",
							"margin-left": "auto",
						}}
					>
						{showAddForm() ? "Cancel" : "+ Add link"}
					</button>
				</Show>
			</div>
			<Show when={addError() !== ""}>
				<pre
					style={{
						color: "var(--color-danger)",
						"white-space": "pre-wrap",
						"font-size": "0.7rem",
						margin: "4px 0",
					}}
				>
					{addError()}
				</pre>
			</Show>
			<Show when={showAddForm()}>
				<AddLinkForm
					store={props.store}
					nookId={props.store.nookId()}
					noteId={props.store.selectedId()}
					predicateIdsAllowed={config().filterPredicateIds}
					targetTypeIdsAllowed={config().filterTypeIds}
					onLinkCreated={() => {
						setShowAddForm(false);
						setAddError("");
						props.store.bumpLinksRevision();
					}}
					onError={setAddError}
				/>
			</Show>
			<Show
				when={items().length > 0}
				fallback={
					<div
						style={{
							"font-size": "0.75rem",
							color: "var(--color-text-muted)",
							"font-style": "italic",
							padding: "4px 0",
						}}
					>
						No linked notes yet.
					</div>
				}
			>
				<div style={{ display: "grid", gap: "2px" }}>
					<For each={items()}>
						{(item) => (
							<div
								style={{
									display: "flex",
									"align-items": "stretch",
									gap: "2px",
									border: "1px solid var(--color-border-light, #e5e7eb)",
									"border-radius": "4px",
									overflow: "hidden",
								}}
							>
								<button
									type="button"
									onClick={() =>
										props.store.onNoteLinkClick(item.noteId, item.nookId)
									}
									style={{
										flex: "1 1 auto",
										padding: "4px 8px",
										border: "none",
										background: "none",
										"text-align": "left",
										cursor: "pointer",
										"font-size": "0.8rem",
										color: "var(--link-color, #0066cc)",
									}}
								>
									{item.noteTitle || "(untitled)"}
									<Show when={item.predicateLabel}>
										<span
											style={{
												color: "var(--color-text-muted)",
												"margin-left": "6px",
												"font-size": "0.7rem",
											}}
										>
											{item.predicateLabel}
										</span>
									</Show>
								</button>
								<Show when={props.store.canWrite() && item.linkId}>
									<button
										type="button"
										title="Remove link"
										aria-label={`Remove link to ${item.noteTitle || "note"}`}
										onClick={(e) => {
											e.stopPropagation();
											if (item.linkId) {
												void deleteLink(item.linkId, item.noteTitle);
											}
										}}
										style={{
											flex: "0 0 auto",
											padding: "4px 10px",
											border: "none",
											"border-left":
												"1px solid var(--color-border-light, #e5e7eb)",
											background: "none",
											cursor: "pointer",
											"font-size": "0.9rem",
											color: "var(--color-text-muted, #9ca3af)",
											// Big enough tap target on mobile — the flex row's
											// stretch alignment makes it fill the item height.
											"min-width": "36px",
										}}
									>
										✕
									</button>
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
