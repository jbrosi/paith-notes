import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import type { PreviewAction } from "../../components/NotePreview";
import { RemoteNoteSearchSelect } from "../../components/RemoteNoteSearchSelect";
import type { NotePreviewController } from "./NookDefaultLayout";
import type { NookStore } from "./store";
import {
	type LinkPredicate,
	type LinkPredicateRule,
	LinkPredicateRulesListResponseSchema,
	LinkPredicatesListResponseSchema,
	type NoteLink,
	NoteLinkResponseSchema,
	NoteLinksListResponseSchema,
} from "./types";

export type NookNoteLinksPanelProps = {
	store: NookStore;
	notePreview?: NotePreviewController;
};

export function NookNoteLinksPanel(props: NookNoteLinksPanelProps) {
	const store = () => props.store;
	const nookId = () => store().nookId();
	const noteId = () => store().selectedId();

	const [loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [predicates, setPredicates] = createSignal<LinkPredicate[]>([]);
	const [links, setLinks] = createSignal<NoteLink[]>([]);
	const [rules, setRules] = createSignal<LinkPredicateRule[]>([]);

	const [newPredicateId, setNewPredicateId] = createSignal<string>("");
	const [newTargetNoteId, setNewTargetNoteId] = createSignal<string>("");
	const [newStartDate, setNewStartDate] = createSignal<string>("");
	const [newEndDate, setNewEndDate] = createSignal<string>("");
	const [showAddForm, setShowAddForm] = createSignal<boolean>(false);

	const titleForLink = (l: NoteLink, id: string) => {
		if (l.sourceNoteId === id) {
			return l.sourceNoteTitle?.trim() ? l.sourceNoteTitle : id;
		}
		if (l.targetNoteId === id) {
			return l.targetNoteTitle?.trim() ? l.targetNoteTitle : id;
		}
		return id;
	};

	const typeParentById = createMemo(() => {
		const m = new Map<string, string>();
		for (const t of store().noteTypes()) {
			m.set(t.id, t.parentId);
		}
		return m;
	});

	const isSameOrDescendant = (childId: string, ancestorId: string) => {
		const child = childId.trim();
		const ancestor = ancestorId.trim();
		if (child === "" || ancestor === "") return false;
		if (child === ancestor) return true;
		let cur = child;
		const parentMap = typeParentById();
		for (let i = 0; i < 64; i++) {
			const p = parentMap.get(cur) ?? "";
			if (p === "") return false;
			if (p === ancestor) return true;
			cur = p;
		}
		return false;
	};

	const loadPredicates = async () => {
		if (nookId().trim() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(`/api/nooks/${nookId()}/link-predicates`, {
				method: "GET",
			});
			if (!res.ok) {
				throw new Error(
					`Failed to load link predicates: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicatesListResponseSchema.parse(json);
			setPredicates(body.predicates);
			if (newPredicateId().trim() === "" && body.predicates.length > 0) {
				setNewPredicateId(body.predicates[0].id);
			}
		} catch (e) {
			setPredicates([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const loadRules = async (predicateId: string) => {
		const pid = predicateId.trim();
		if (pid === "") {
			setRules([]);
			return;
		}
		if (nookId().trim() === "") return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/link-predicates/${pid}/rules`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to load rules: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = LinkPredicateRulesListResponseSchema.parse(json);
			setRules(body.rules);
		} catch (e) {
			setRules([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const loadLinks = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") {
			setLinks([]);
			return;
		}
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links?direction=both&depth=1`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to load links: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteLinksListResponseSchema.parse(json);
			setLinks(body.links);
		} catch (e) {
			setLinks([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const createLink = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") return;

		const pid = newPredicateId().trim();
		if (pid === "") {
			setError("Choose a predicate");
			return;
		}
		const tid = newTargetNoteId().trim();
		if (tid === "") {
			setError("Choose a target note");
			return;
		}
		if (tid === noteId().trim()) {
			setError("Cannot link a note to itself");
			return;
		}

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						predicate_id: pid,
						target_note_id: tid,
						start_date: newStartDate().trim() || undefined,
						end_date: newEndDate().trim() || undefined,
					}),
				},
			);
			if (!res.ok) {
				throw new Error(
					`Failed to create link: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteLinkResponseSchema.parse(json);
			setLinks([body.link, ...links()]);
			setNewStartDate("");
			setNewEndDate("");
			setShowAddForm(false);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const deleteLink = async (linkId: string) => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") return;
		const id = linkId.trim();
		if (id === "") return;

		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links/${id}`,
				{ method: "DELETE" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to delete link: ${res.status} ${res.statusText}`,
				);
			}
			setLinks(links().filter((l) => l.id !== id));
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const otherNoteId = (l: NoteLink) => {
		return l.sourceNoteId === noteId() ? l.targetNoteId : l.sourceNoteId;
	};

	const directionLabel = (l: NoteLink) => {
		return l.sourceNoteId === noteId() ? l.forwardLabel : l.reverseLabel;
	};

	createEffect(() => {
		void loadPredicates();
	});

	createEffect(() => {
		void loadLinks();
	});

	createEffect(() => {
		void noteId();
		setNewTargetNoteId("");
		setNewStartDate("");
		setNewEndDate("");
		setShowAddForm(false);
	});

	createEffect(() => {
		const pid = newPredicateId().trim();
		void pid;
		setNewTargetNoteId("");
		void loadRules(pid);
	});

	const allowedTargetTypeOptions = createMemo(() => {
		const sourceTypeId = store().typeId().trim();
		const activeRules = rules();
		const types = store().noteTypes();
		const typeById = new Map(types.map((t) => [t.id, t.label] as const));

		if (activeRules.length === 0) {
			return types.map((t) => ({ id: t.id, label: t.label }));
		}

		const allowed = new Set<string>();
		let anyAllowed = false;
		for (const r of activeRules) {
			const ruleSource = r.sourceTypeId.trim();
			const sourceOk =
				ruleSource === "" ||
				(sourceTypeId !== "" &&
					(r.includeSourceSubtypes
						? isSameOrDescendant(sourceTypeId, ruleSource)
						: sourceTypeId === ruleSource));
			if (!sourceOk) continue;
			const ruleTarget = r.targetTypeId.trim();
			if (ruleTarget === "") {
				anyAllowed = true;
				break;
			}
			allowed.add(ruleTarget);
		}

		if (anyAllowed) {
			return types.map((t) => ({ id: t.id, label: t.label }));
		}

		return Array.from(allowed)
			.map((id) => ({ id, label: typeById.get(id) ?? id }))
			.sort((a, b) => a.label.localeCompare(b.label));
	});

	const allowedTargetTypeIds = createMemo(
		() => new Set(allowedTargetTypeOptions().map((o) => o.id)),
	);

	const allowedTargetTypeLabel = createMemo(() => {
		const opts = allowedTargetTypeOptions();
		if (opts.length === 0) return "";
		return opts.map((o) => o.label).join(", ");
	});

	const isTypeAllowed = (typeId: string) => {
		const id = typeId.trim();
		if (id === "") return false;
		const allowed = allowedTargetTypeIds();
		if (allowed.size === 0) return true;
		for (const rootId of allowed) {
			if (id === rootId || isSameOrDescendant(id, rootId)) return true;
		}
		return false;
	};

	return (
		<div
			style={{
				"margin-top": "12px",
				padding: "8px 10px",
				border: "1px solid #eee",
				"border-radius": "8px",
				background: "var(--color-bg-secondary)",
			}}
		>
			<div style={{ display: "flex", "justify-content": "space-between" }}>
				<div style={{ "font-weight": 600 }}>Links</div>
			</div>

			<Show when={error() !== ""}>
				<pre style={{ color: "var(--color-danger)", "white-space": "pre-wrap" }}>
					{error()}
				</pre>
			</Show>

			<Show when={noteId().trim() !== ""} fallback={<div>Select a note</div>}>
				<div
					style={{ display: "flex", "flex-direction": "column", gap: "10px" }}
				>
					<Show when={store().mode() === "edit"}>
						<div>
							<Button
								variant="secondary"
								onClick={() => setShowAddForm((v) => !v)}
							>
								{showAddForm() ? "Cancel" : "+ Add link"}
							</Button>
						</div>
						<Show when={showAddForm()}>
							<div
								style={{
									display: "grid",
									"grid-template-columns": "1fr 1fr",
									gap: "8px",
								}}
							>
								<label>
									Predicate
									<select
										value={newPredicateId()}
										onChange={(e) => setNewPredicateId(e.currentTarget.value)}
										disabled={loading()}
										style={{ width: "100%", padding: "6px" }}
									>
										<For each={predicates()}>
											{(p) => (
												<option value={p.id}>
													{p.key} ({p.forwardLabel} / {p.reverseLabel})
												</option>
											)}
										</For>
									</select>
								</label>

								<div>
									<div>Target note</div>
									<RemoteNoteSearchSelect
										value={newTargetNoteId()}
										onChange={(id) => setNewTargetNoteId(id)}
										nookId={nookId()}
										noteTypes={store().noteTypes()}
										excludeIds={[noteId()]}
										isTypeAllowed={(id) => isTypeAllowed(id)}
										allowedTypesLabel={allowedTargetTypeLabel()}
										placeholder="Target note…"
										disabled={loading()}
									/>
								</div>
							</div>

							<div
								style={{
									display: "grid",
									"grid-template-columns": "1fr 1fr",
									gap: "8px",
								}}
							>
								<label>
									Start date
									<input
										type="date"
										value={newStartDate()}
										onInput={(e) => setNewStartDate(e.currentTarget.value)}
										disabled={loading()}
										style={{ width: "100%", padding: "6px" }}
									/>
								</label>
								<label>
									End date
									<input
										type="date"
										value={newEndDate()}
										onInput={(e) => setNewEndDate(e.currentTarget.value)}
										disabled={loading()}
										style={{ width: "100%", padding: "6px" }}
									/>
								</label>
							</div>

							<Button onClick={() => void createLink()} disabled={loading()}>
								Add link
							</Button>
						</Show>
					</Show>

					<div>
						<div style={{ "font-weight": 600, "margin-bottom": "6px" }}>
							Existing links
						</div>
						<Show
							when={links().length > 0}
							fallback={<div style={{ color: "var(--color-text-muted)" }}>(none)</div>}
						>
							<For each={links()}>
								{(l) => (
									<button
										type="button"
										onClick={(e) => {
											const otherId = otherNoteId(l);
											const actions: PreviewAction[] = [];
											if (store().mode() === "edit") {
												actions.push({
													label: "Remove link",
													danger: true,
													onClick: () => void deleteLink(l.id),
												});
											}
											props.notePreview?.show(otherId, e.clientX, e.clientY, {
												immediate: true,
												onOpen: (id) => void store().onNoteLinkClick(id),
												actions,
											});
										}}
										onMouseEnter={(e) =>
											props.notePreview?.show(
												otherNoteId(l),
												e.clientX,
												e.clientY,
												{
													onOpen: (id) => void store().onNoteLinkClick(id),
												},
											)
										}
										onMouseLeave={() => props.notePreview?.hide()}
										style={{
											display: "flex",
											width: "100%",
											"text-align": "left",
											gap: "8px",
											"align-items": "center",
											padding: "6px",
											border: "1px solid #ddd",
											"border-radius": "6px",
											"margin-bottom": "6px",
											background: "white",
											cursor: "pointer",
											font: "inherit",
										}}
									>
										<div style={{ flex: "1" }}>
											<div>
												<strong>{directionLabel(l)}</strong>{" "}
												{titleForLink(l, otherNoteId(l))}
											</div>
											<Show when={l.startDate !== "" || l.endDate !== ""}>
												<div style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>
													{l.startDate || "(no start)"} →{" "}
													{l.endDate || "(no end)"}
												</div>
											</Show>
										</div>
									</button>
								)}
							</For>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
