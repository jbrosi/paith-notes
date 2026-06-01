import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { Button } from "../../../components/Button";
import type { NookStore } from "../store";
import type { NoteType, TypeAttribute } from "../types";
import { TypeAttributesListResponseSchema } from "../types";

type SavedView = {
	id: string;
	name: string;
	typeId: string;
	filters: Array<{ attribute_id: string; op: string; value: unknown }>;
	sort: Record<string, unknown>;
	display: "list" | "cards" | "table";
};

type ViewNote = {
	id: string;
	title: string;
	typeId: string;
	attributes: Record<string, unknown>;
	createdAt: string;
};

export function SavedViewsPanel(props: { store: NookStore }) {
	const [activeView, setActiveView] = createSignal<SavedView | null>(null);
	const [editingView, setEditingView] = createSignal<SavedView | null>(null);
	const [viewNotes, setViewNotes] = createSignal<ViewNote[]>([]);
	const [viewAttrs, setViewAttrs] = createSignal<TypeAttribute[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal("");

	const fetchViews = async (): Promise<SavedView[]> => {
		const nookId = props.store.nookId();
		if (!nookId) return [];
		const res = await apiFetch(`/api/nooks/${nookId}/saved-views`);
		if (!res.ok) return [];
		const json = await res.json();
		return ((json as { views?: unknown[] }).views ?? []).map(parseView);
	};

	const [views, { refetch }] = createResource(
		() => props.store.nookId(),
		fetchViews,
	);

	const executeView = async (view: SavedView) => {
		setActiveView(view);
		setEditingView(null);
		setLoading(true);
		setError("");
		try {
			const nookId = props.store.nookId();
			const typeId = view.typeId || "all";
			const params = new URLSearchParams();
			if (view.filters.length > 0) {
				params.set("attribute_filters", JSON.stringify(view.filters));
			}
			const qs = params.toString() ? `?${params}` : "";
			const res = await apiFetch(
				`/api/nooks/${nookId}/note-types/${typeId}/notes${qs}`,
			);
			if (!res.ok) throw new Error("Failed to load view");
			const json = await res.json();
			const notes = ((json as { notes?: unknown[] }).notes ?? []).map(
				(n: unknown) => {
					const r = n as Record<string, unknown>;
					return {
						id: String(r.id ?? ""),
						title: String(r.title ?? ""),
						typeId: String(r.type_id ?? ""),
						attributes:
							typeof r.attributes === "object" && r.attributes !== null
								? (r.attributes as Record<string, unknown>)
								: {},
						createdAt: String(r.created_at ?? ""),
					};
				},
			);
			setViewNotes(notes);

			if (view.typeId) {
				const attrRes = await apiFetch(
					`/api/nooks/${nookId}/note-types/${view.typeId}/attributes`,
				);
				if (attrRes.ok) {
					const attrJson = await attrRes.json();
					setViewAttrs(
						TypeAttributesListResponseSchema.parse(attrJson).attributes.filter(
							(a) => a.kind !== "file" && a.kind !== "graph",
						),
					);
				}
			} else {
				setViewAttrs([]);
			}
		} catch (e) {
			setError(String(e));
			setViewNotes([]);
		} finally {
			setLoading(false);
		}
	};

	const onDeleteView = async (view: SavedView) => {
		if (!window.confirm(`Delete view "${view.name}"?`)) return;
		const nookId = props.store.nookId();
		await apiFetch(`/api/nooks/${nookId}/saved-views/${view.id}`, {
			method: "DELETE",
		});
		if (activeView()?.id === view.id) {
			setActiveView(null);
			setViewNotes([]);
		}
		void refetch();
	};

	const onSaveView = async (view: SavedView) => {
		const nookId = props.store.nookId();
		const isNew = view.id === "";
		const url = isNew
			? `/api/nooks/${nookId}/saved-views`
			: `/api/nooks/${nookId}/saved-views/${view.id}`;
		const res = await apiFetch(url, {
			method: isNew ? "POST" : "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: view.name,
				type_id: view.typeId,
				filters: view.filters,
				sort: view.sort,
				display: view.display,
			}),
		});
		if (res.ok) {
			setEditingView(null);
			void refetch();
			if (!isNew) {
				// Re-execute after edit
				const json = await res.json();
				const saved = parseView((json as { view: unknown }).view);
				void executeView(saved);
			}
		}
	};

	const navigateToNote = (noteId: string) => {
		props.store.onNoteLinkClick(noteId);
	};

	return (
		<div style={{ padding: "8px" }}>
			<div
				style={{
					display: "flex",
					"align-items": "center",
					gap: "8px",
					"margin-bottom": "8px",
				}}
			>
				<h3 style={{ margin: 0, "font-size": "14px" }}>Views</h3>
				<Show when={!editingView()}>
					<Button
						size="small"
						onClick={() =>
							setEditingView({
								id: "",
								name: "",
								typeId: "",
								filters: [],
								sort: {},
								display: "list",
							})
						}
					>
						+ New
					</Button>
				</Show>
				<Show when={activeView() && !editingView()}>
					<Button
						size="small"
						variant="secondary"
						onClick={() => {
							setActiveView(null);
							setViewNotes([]);
						}}
					>
						Close
					</Button>
				</Show>
			</div>

			<Show when={error() !== ""}>
				<div style={{ color: "var(--color-danger)", "font-size": "12px", "margin-bottom": "8px" }}>
					{error()}
				</div>
			</Show>

			{/* View editor */}
			<Show when={editingView()}>
				{(view) => (
					<ViewEditor
						view={view()}
						types={props.store.noteTypes()}
						nookId={props.store.nookId()}
						onSave={(v) => void onSaveView(v)}
						onCancel={() => setEditingView(null)}
					/>
				)}
			</Show>

			{/* View list */}
			<Show when={!activeView() && !editingView()}>
				<div style={{ display: "grid", gap: "4px" }}>
					<For each={views() ?? []}>
						{(view) => (
							<div
								style={{
									display: "flex",
									"align-items": "center",
									gap: "6px",
									padding: "6px 8px",
									border: "1px solid var(--color-border-light)",
									"border-radius": "6px",
									cursor: "pointer",
								}}
								onClick={() => void executeView(view)}
							>
								<span style={{ flex: 1, "font-size": "13px" }}>
									{view.name}
									<span style={{ color: "var(--color-text-muted)", "margin-left": "6px", "font-size": "11px" }}>
										{view.display}
										{view.filters.length > 0 ? ` · ${view.filters.length} filter${view.filters.length > 1 ? "s" : ""}` : ""}
									</span>
								</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setEditingView(view);
									}}
									style={{ border: "none", background: "none", color: "var(--color-text-muted)", cursor: "pointer", "font-size": "12px" }}
								>
									Edit
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void onDeleteView(view);
									}}
									style={{ border: "none", background: "none", color: "var(--color-text-muted)", cursor: "pointer", "font-size": "14px" }}
								>
									×
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>

			{/* Active view results */}
			<Show when={activeView() !== null && !editingView()}>
				{(_) => {
					const view = () => activeView()!;
					return (
					<>
						<div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "8px" }}>
							<span style={{ "font-weight": "600", "font-size": "13px" }}>
								{view().name}
							</span>
							<span style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>
								{viewNotes().length} notes
							</span>
							<Button size="small" variant="secondary" onClick={() => setEditingView(view())}>
								Edit
							</Button>
						</div>

						<Show when={loading()}>
							<div style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>Loading...</div>
						</Show>

						<Show when={!loading()}>
							{view().display === "table" ? (
								<TableView notes={viewNotes()} attrs={viewAttrs()} onSelect={navigateToNote} />
							) : view().display === "cards" ? (
								<CardsView notes={viewNotes()} attrs={viewAttrs()} onSelect={navigateToNote} />
							) : (
								<ListView notes={viewNotes()} onSelect={navigateToNote} />
							)}
						</Show>
					</>
					);
				}}
			</Show>
		</div>
	);
}

// ─── View Editor ────────────────────────────────────────────────────────────

function ViewEditor(props: {
	view: SavedView;
	types: NoteType[];
	nookId: string;
	onSave: (v: SavedView) => void;
	onCancel: () => void;
}) {
	const [name, setName] = createSignal(props.view.name);
	const [typeId, setTypeId] = createSignal(props.view.typeId);
	const [display, setDisplay] = createSignal(props.view.display);
	const [filters, setFilters] = createSignal(props.view.filters);
	const [typeAttrs, setTypeAttrs] = createSignal<TypeAttribute[]>([]);

	const loadAttrs = async (tid: string) => {
		if (!tid) { setTypeAttrs([]); return; }
		const res = await apiFetch(`/api/nooks/${props.nookId}/note-types/${tid}/attributes`);
		if (res.ok) {
			const json = await res.json();
			setTypeAttrs(TypeAttributesListResponseSchema.parse(json).attributes.filter(a => a.kind !== "file" && a.kind !== "graph"));
		}
	};

	// Load attrs for initial type
	if (props.view.typeId) void loadAttrs(props.view.typeId);

	const addFilter = () => {
		const attrs = typeAttrs();
		if (attrs.length === 0) return;
		setFilters([...filters(), { attribute_id: attrs[0].id, op: "eq", value: "" }]);
	};

	const removeFilter = (idx: number) => {
		setFilters(filters().filter((_, i) => i !== idx));
	};

	const updateFilter = (idx: number, patch: Partial<SavedView["filters"][0]>) => {
		setFilters(filters().map((f, i) => (i === idx ? { ...f, ...patch } : f)));
	};

	const opsForKind = (kind: string): Array<{ value: string; label: string }> => {
		switch (kind) {
			case "number": return [
				{ value: "eq", label: "=" }, { value: "neq", label: "≠" },
				{ value: "gt", label: ">" }, { value: "gte", label: "≥" },
				{ value: "lt", label: "<" }, { value: "lte", label: "≤" },
			];
			case "date": return [
				{ value: "date_gte", label: "≥" }, { value: "date_lte", label: "≤" },
				{ value: "date_gt", label: ">" }, { value: "date_lt", label: "<" },
			];
			case "text": return [
				{ value: "eq", label: "=" }, { value: "contains", label: "contains" },
				{ value: "starts_with", label: "starts with" },
			];
			case "select": return [
				{ value: "eq", label: "=" }, { value: "neq", label: "≠" },
				{ value: "in", label: "in" },
			];
			case "boolean": return [
				{ value: "eq", label: "=" },
			];
			default: return [{ value: "eq", label: "=" }];
		}
	};

	const attrById = (id: string) => typeAttrs().find(a => a.id === id);

	const inputStyle = { padding: "4px 6px", "font-size": "12px", "min-width": "60px" };

	return (
		<div style={{
			display: "grid", gap: "8px", padding: "10px",
			border: "1px solid var(--color-border-medium)", "border-radius": "8px",
			background: "var(--color-bg-secondary)", "margin-bottom": "8px",
		}}>
			<input
				value={name()} onInput={(e) => setName(e.currentTarget.value)}
				placeholder="View name" style={{ padding: "6px 8px", "font-size": "13px" }}
			/>

			<div style={{ display: "flex", gap: "6px" }}>
				<select
					value={typeId()}
					onChange={(e) => {
						setTypeId(e.currentTarget.value);
						setFilters([]);
						void loadAttrs(e.currentTarget.value);
					}}
					style={{ flex: 1, padding: "4px 6px", "font-size": "12px" }}
				>
					<option value="">All types</option>
					<For each={props.types}>{(t) => <option value={t.id}>{t.label}</option>}</For>
				</select>

				<select
					value={display()} onChange={(e) => setDisplay(e.currentTarget.value as SavedView["display"])}
					style={{ padding: "4px 6px", "font-size": "12px" }}
				>
					<option value="list">List</option>
					<option value="cards">Cards</option>
					<option value="table">Table</option>
				</select>
			</div>

			{/* Filters */}
			<Show when={typeAttrs().length > 0}>
				<div style={{ "font-size": "12px", color: "var(--color-text-secondary)", "margin-top": "4px" }}>Filters</div>
				<For each={filters()}>
					{(f, idx) => {
						const attr = () => attrById(f.attribute_id);
						return (
							<div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
								<select
									value={f.attribute_id}
									onChange={(e) => updateFilter(idx(), { attribute_id: e.currentTarget.value, op: "eq", value: "" })}
									style={inputStyle}
								>
									<For each={typeAttrs()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
								</select>
								<select
									value={f.op}
									onChange={(e) => updateFilter(idx(), { op: e.currentTarget.value })}
									style={inputStyle}
								>
									<For each={opsForKind(attr()?.kind ?? "text")}>
										{(o) => <option value={o.value}>{o.label}</option>}
									</For>
								</select>
								<Show when={f.op !== "is_null" && f.op !== "is_not_null"}>
									<input
										value={String(f.value ?? "")}
										onInput={(e) => {
											const k = attr()?.kind;
											const v = k === "number" ? Number(e.currentTarget.value) || 0 : e.currentTarget.value;
											updateFilter(idx(), { value: v });
										}}
										placeholder="value"
										type={attr()?.kind === "number" ? "number" : attr()?.kind === "date" ? "date" : "text"}
										style={{ ...inputStyle, flex: 1 }}
									/>
								</Show>
								<button type="button" onClick={() => removeFilter(idx())}
									style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-text-muted)" }}>×</button>
							</div>
						);
					}}
				</For>
				<Button size="small" variant="secondary" onClick={addFilter}>+ Filter</Button>
			</Show>

			<div style={{ display: "flex", gap: "6px" }}>
				<Button size="small" onClick={() => props.onSave({
					...props.view, name: name(), typeId: typeId(), display: display(), filters: filters(),
				})}>
					Save
				</Button>
				<Button size="small" variant="secondary" onClick={props.onCancel}>Cancel</Button>
			</div>
		</div>
	);
}

// ─── Display Modes ──────────────────────────────────────────────────────────

function ListView(props: { notes: ViewNote[]; onSelect: (id: string) => void }) {
	return (
		<div style={{ display: "grid", gap: "2px" }}>
			<For each={props.notes}>
				{(n) => (
					<div style={{ padding: "6px 8px", border: "1px solid var(--color-border-light)", "border-radius": "4px", cursor: "pointer", "font-size": "13px" }}
						onClick={() => props.onSelect(n.id)}>
						{n.title}
					</div>
				)}
			</For>
		</div>
	);
}

function CardsView(props: { notes: ViewNote[]; attrs: TypeAttribute[]; onSelect: (id: string) => void }) {
	return (
		<div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px" }}>
			<For each={props.notes}>
				{(n) => (
					<div style={{ padding: "10px", border: "1px solid var(--color-border-light)", "border-radius": "8px", cursor: "pointer", background: "var(--color-bg)" }}
						onClick={() => props.onSelect(n.id)}>
						<div style={{ "font-weight": "600", "font-size": "13px", "margin-bottom": "6px" }}>{n.title}</div>
						<For each={props.attrs.slice(0, 3)}>
							{(attr) => {
								const val = n.attributes[attr.id];
								if (val === undefined || val === null || val === "") return null;
								return (
									<div style={{ "font-size": "11px", color: "var(--color-text-muted)", "margin-bottom": "2px" }}>
										<span style={{ color: "var(--color-text-secondary)" }}>{attr.name}:</span>{" "}{formatAttrValue(val, attr)}
									</div>
								);
							}}
						</For>
					</div>
				)}
			</For>
		</div>
	);
}

function TableView(props: { notes: ViewNote[]; attrs: TypeAttribute[]; onSelect: (id: string) => void }) {
	return (
		<div style={{ overflow: "auto" }}>
			<table style={{ width: "100%", "border-collapse": "collapse", "font-size": "12px" }}>
				<thead>
					<tr>
						<th style={{ "text-align": "left", padding: "6px 8px", "border-bottom": "2px solid var(--color-border-medium)", "font-size": "11px", color: "var(--color-text-secondary)" }}>Title</th>
						<For each={props.attrs}>
							{(attr) => (
								<th style={{ "text-align": "left", padding: "6px 8px", "border-bottom": "2px solid var(--color-border-medium)", "font-size": "11px", color: "var(--color-text-secondary)" }}>{attr.name}</th>
							)}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={props.notes}>
						{(n) => (
							<tr style={{ cursor: "pointer" }} onClick={() => props.onSelect(n.id)}>
								<td style={{ padding: "6px 8px", "border-bottom": "1px solid var(--color-border-light)" }}>{n.title}</td>
								<For each={props.attrs}>
									{(attr) => (
										<td style={{ padding: "6px 8px", "border-bottom": "1px solid var(--color-border-light)", color: "var(--color-text-muted)" }}>
											{formatAttrValue(n.attributes[attr.id], attr)}
										</td>
									)}
								</For>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseView(v: unknown): SavedView {
	const r = v as Record<string, unknown>;
	return {
		id: String(r.id ?? ""),
		name: String(r.name ?? ""),
		typeId: String(r.type_id ?? ""),
		filters: Array.isArray(r.filters) ? (r.filters as SavedView["filters"]) : [],
		sort: typeof r.sort === "object" && r.sort !== null ? (r.sort as Record<string, unknown>) : {},
		display: (["list", "cards", "table"].includes(String(r.display)) ? String(r.display) : "list") as SavedView["display"],
	};
}

function formatAttrValue(val: unknown, attr: TypeAttribute): string {
	if (val === undefined || val === null) return "";
	if (attr.kind === "boolean") return val ? "Yes" : "No";
	if (attr.kind === "date_range" && typeof val === "object") {
		const r = val as { from?: string; to?: string };
		return `${r.from ?? ""} – ${r.to ?? ""}`;
	}
	if (attr.kind === "number" && attr.config.display === "rating") {
		const n = Number(val) || 0;
		const max = Number(attr.config.max ?? 5) || 5;
		return "★".repeat(n) + "☆".repeat(Math.max(0, max - n));
	}
	return String(val);
}
