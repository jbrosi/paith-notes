import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { Button } from "../../../components/Button";
import type { NookStore } from "../store";
import type { TypeAttribute } from "../types";
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
		return ((json as { views?: unknown[] }).views ?? []).map((v: unknown) => {
			const r = v as Record<string, unknown>;
			return {
				id: String(r.id ?? ""),
				name: String(r.name ?? ""),
				typeId: String(r.type_id ?? ""),
				filters: Array.isArray(r.filters) ? r.filters as SavedView["filters"] : [],
				sort: typeof r.sort === "object" && r.sort !== null ? r.sort as Record<string, unknown> : {},
				display: (["list", "cards", "table"].includes(String(r.display)) ? String(r.display) : "list") as SavedView["display"],
			};
		});
	};

	const [views, { refetch }] = createResource(
		() => props.store.nookId(),
		fetchViews,
	);

	const executeView = async (view: SavedView) => {
		setActiveView(view);
		setLoading(true);
		setError("");
		try {
			const nookId = props.store.nookId();
			const typeId = view.typeId || "all";
			const params = new URLSearchParams();
			if (view.filters.length > 0) {
				params.set("attribute_filters", JSON.stringify(view.filters));
			}
			if (view.sort && typeof view.sort.attribute_id === "string") {
				params.set("sort", view.sort.dir === "asc" ? "oldest" : "newest");
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
						attributes: typeof r.attributes === "object" && r.attributes !== null
							? (r.attributes as Record<string, unknown>)
							: {},
						createdAt: String(r.created_at ?? ""),
					};
				},
			);
			setViewNotes(notes);

			// Load attributes for the type
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

	const onCreateView = async () => {
		const name = window.prompt("View name");
		if (!name?.trim()) return;
		const nookId = props.store.nookId();
		const res = await apiFetch(`/api/nooks/${nookId}/saved-views`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: name.trim(), display: "list" }),
		});
		if (res.ok) void refetch();
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
				<Button size="small" onClick={onCreateView}>
					+ New
				</Button>
				<Show when={activeView()}>
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
				<div
					style={{
						color: "var(--color-danger)",
						"font-size": "12px",
						"margin-bottom": "8px",
					}}
				>
					{error()}
				</div>
			</Show>

			<Show when={!activeView()}>
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
									<span
										style={{
											color: "var(--color-text-muted)",
											"margin-left": "6px",
											"font-size": "11px",
										}}
									>
										{view.display}
									</span>
								</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void onDeleteView(view);
									}}
									style={{
										border: "none",
										background: "none",
										color: "var(--color-text-muted)",
										cursor: "pointer",
										"font-size": "14px",
									}}
								>
									×
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>

			<Show when={activeView()}>
				{(view) => (
					<>
						<div
							style={{
								"font-weight": "600",
								"font-size": "13px",
								"margin-bottom": "8px",
							}}
						>
							{view().name}
							<span
								style={{
									color: "var(--color-text-muted)",
									"font-weight": "normal",
									"margin-left": "8px",
								}}
							>
								{viewNotes().length} notes
							</span>
						</div>

						<Show when={loading()}>
							<div style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>
								Loading...
							</div>
						</Show>

						<Show when={!loading()}>
							{view().display === "table" ? (
								<TableView
									notes={viewNotes()}
									attrs={viewAttrs()}
									onSelect={navigateToNote}
								/>
							) : view().display === "cards" ? (
								<CardsView
									notes={viewNotes()}
									attrs={viewAttrs()}
									onSelect={navigateToNote}
								/>
							) : (
								<ListView notes={viewNotes()} onSelect={navigateToNote} />
							)}
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}

function ListView(props: {
	notes: ViewNote[];
	onSelect: (id: string) => void;
}) {
	return (
		<div style={{ display: "grid", gap: "2px" }}>
			<For each={props.notes}>
				{(n) => (
					<div
						style={{
							padding: "6px 8px",
							border: "1px solid var(--color-border-light)",
							"border-radius": "4px",
							cursor: "pointer",
							"font-size": "13px",
						}}
						onClick={() => props.onSelect(n.id)}
					>
						{n.title}
					</div>
				)}
			</For>
		</div>
	);
}

function CardsView(props: {
	notes: ViewNote[];
	attrs: TypeAttribute[];
	onSelect: (id: string) => void;
}) {
	return (
		<div
			style={{
				display: "grid",
				"grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))",
				gap: "8px",
			}}
		>
			<For each={props.notes}>
				{(n) => (
					<div
						style={{
							padding: "10px",
							border: "1px solid var(--color-border-light)",
							"border-radius": "8px",
							cursor: "pointer",
							background: "var(--color-bg)",
						}}
						onClick={() => props.onSelect(n.id)}
					>
						<div
							style={{
								"font-weight": "600",
								"font-size": "13px",
								"margin-bottom": "6px",
							}}
						>
							{n.title}
						</div>
						<For each={props.attrs.slice(0, 3)}>
							{(attr) => {
								const val = n.attributes[attr.id];
								if (val === undefined || val === null || val === "")
									return null;
								return (
									<div
										style={{
											"font-size": "11px",
											color: "var(--color-text-muted)",
											"margin-bottom": "2px",
										}}
									>
										<span style={{ color: "var(--color-text-secondary)" }}>
											{attr.name}:
										</span>{" "}
										{formatAttrValue(val, attr)}
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

function TableView(props: {
	notes: ViewNote[];
	attrs: TypeAttribute[];
	onSelect: (id: string) => void;
}) {
	return (
		<div style={{ overflow: "auto" }}>
			<table
				style={{
					width: "100%",
					"border-collapse": "collapse",
					"font-size": "12px",
				}}
			>
				<thead>
					<tr>
						<th
							style={{
								"text-align": "left",
								padding: "6px 8px",
								"border-bottom": "2px solid var(--color-border-medium)",
								"font-size": "11px",
								color: "var(--color-text-secondary)",
							}}
						>
							Title
						</th>
						<For each={props.attrs}>
							{(attr) => (
								<th
									style={{
										"text-align": "left",
										padding: "6px 8px",
										"border-bottom":
											"2px solid var(--color-border-medium)",
										"font-size": "11px",
										color: "var(--color-text-secondary)",
									}}
								>
									{attr.name}
								</th>
							)}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={props.notes}>
						{(n) => (
							<tr
								style={{ cursor: "pointer" }}
								onClick={() => props.onSelect(n.id)}
							>
								<td
									style={{
										padding: "6px 8px",
										"border-bottom":
											"1px solid var(--color-border-light)",
									}}
								>
									{n.title}
								</td>
								<For each={props.attrs}>
									{(attr) => (
										<td
											style={{
												padding: "6px 8px",
												"border-bottom":
													"1px solid var(--color-border-light)",
												color: "var(--color-text-muted)",
											}}
										>
											{formatAttrValue(
												n.attributes[attr.id],
												attr,
											)}
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

function formatAttrValue(
	val: unknown,
	attr: TypeAttribute,
): string {
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
