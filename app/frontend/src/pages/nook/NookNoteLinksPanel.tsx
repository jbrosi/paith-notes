import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import { NoteSearchSelect } from "../../components/NoteSearchSelect";
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
	const [targetTypeFilterId, setTargetTypeFilterId] = createSignal<string>("");
	const [newStartDate, setNewStartDate] = createSignal<string>("");
	const [newEndDate, setNewEndDate] = createSignal<string>("");

	const notesById = createMemo(() => {
		const map = new Map<string, string>();
		for (const n of store().allNotes()) {
			map.set(n.id, n.title);
		}
		return map;
	});

	const titleFor = (id: string) => notesById().get(id) ?? id;

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
				`/api/nooks/${nookId()}/notes/${noteId()}/links?direction=both`,
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
	});

	createEffect(() => {
		const pid = newPredicateId().trim();
		void pid;
		setNewTargetNoteId("");
		setTargetTypeFilterId("");
		void loadRules(pid);
	});

	const parentByTypeId = createMemo(() => {
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
		for (let i = 0; i < 64; i++) {
			const p = parentByTypeId().get(cur) ?? "";
			if (p === "") return false;
			if (p === ancestor) return true;
			cur = p;
		}
		return false;
	};

	const targetCandidates = createMemo(() => {
		const id = noteId().trim();
		const sourceTypeId = store().typeId().trim();
		const activeRules = rules();
		return store()
			.allNotes()
			.filter((n) => n.id !== id)
			.filter((n) => {
				if (activeRules.length === 0) return true;
				const targetTypeId = String(n.typeId ?? "").trim();
				return activeRules.some((r) => {
					const ruleSource = r.sourceTypeId.trim();
					const ruleTarget = r.targetTypeId.trim();
					const sourceOk =
						ruleSource === "" ||
						(sourceTypeId !== "" &&
							(r.includeSourceSubtypes
								? isSameOrDescendant(sourceTypeId, ruleSource)
								: sourceTypeId === ruleSource));
					if (!sourceOk) return false;
					if (ruleTarget === "") return true;
					if (targetTypeId === "") return false;
					return r.includeTargetSubtypes
						? isSameOrDescendant(targetTypeId, ruleTarget)
						: targetTypeId === ruleTarget;
				});
			})
			.map((n) => ({
				id: n.id,
				title: n.title,
				subtitle:
					n.type === "file" ? "File" : n.type === "person" ? "Person" : "Note",
				typeId: n.typeId,
			}));
	});

	const allowedTargetTypeOptions = createMemo(() => {
		const sourceTypeId = store().typeId().trim();
		const activeRules = rules();
		const types = store().noteTypes();
		const typeById = new Map(types.map((t) => [t.id, t.label] as const));

		if (activeRules.length === 0) {
			return types
				.filter((t) => t.archivedAt === "")
				.map((t) => ({ id: t.id, label: t.label }));
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
			return types
				.filter((t) => t.archivedAt === "")
				.map((t) => ({ id: t.id, label: t.label }));
		}

		return Array.from(allowed)
			.map((id) => ({ id, label: typeById.get(id) ?? id }))
			.sort((a, b) => a.label.localeCompare(b.label));
	});

	const typeNodes = createMemo(() =>
		store()
			.noteTypes()
			.map((t) => ({ id: t.id, parentId: t.parentId })),
	);

	return (
		<div
			style={{
				"margin-top": "12px",
				padding: "8px 10px",
				border: "1px solid #eee",
				"border-radius": "8px",
				background: "#fafafa",
			}}
		>
			<div style={{ display: "flex", "justify-content": "space-between" }}>
				<div style={{ "font-weight": 600 }}>Links</div>
			</div>

			<Show when={error() !== ""}>
				<pre style={{ color: "#b42318", "white-space": "pre-wrap" }}>
					{error()}
				</pre>
			</Show>

			<Show when={noteId().trim() !== ""} fallback={<div>Select a note</div>}>
				<div
					style={{ display: "flex", "flex-direction": "column", gap: "10px" }}
				>
					<Show when={store().mode() === "edit"}>
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
								<NoteSearchSelect
									value={newTargetNoteId()}
									onChange={(id) => setNewTargetNoteId(id)}
									options={targetCandidates()}
									typeNodes={typeNodes()}
									typeFilter={{
										value: targetTypeFilterId(),
										onChange: (next) => setTargetTypeFilterId(next),
										options: allowedTargetTypeOptions(),
										placeholder: "All types",
										disabled: loading(),
									}}
									filters={{
										typeId: targetTypeFilterId(),
										includeSubtypes: true,
									}}
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

					<div>
						<div style={{ "font-weight": 600, "margin-bottom": "6px" }}>
							Existing links
						</div>
						<Show
							when={links().length > 0}
							fallback={<div style={{ color: "#666" }}>(none)</div>}
						>
							<For each={links()}>
								{(l) => (
									<div
										style={{
											display: "flex",
											gap: "8px",
											"align-items": "center",
											padding: "6px",
											border: "1px solid #ddd",
											"border-radius": "6px",
											"margin-bottom": "6px",
											background: "white",
										}}
									>
										<div style={{ flex: "1" }}>
											<div>
												<strong>{directionLabel(l)}</strong>{" "}
												{titleFor(otherNoteId(l))}
											</div>
											<Show when={l.startDate !== "" || l.endDate !== ""}>
												<div style={{ color: "#666", "font-size": "12px" }}>
													{l.startDate || "(no start)"} →{" "}
													{l.endDate || "(no end)"}
												</div>
											</Show>
										</div>
										<Show when={store().mode() === "edit"}>
											<Button
												variant="secondary"
												onClick={() => void deleteLink(l.id)}
												disabled={loading()}
											>
												Delete
											</Button>
										</Show>
									</div>
								)}
							</For>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
