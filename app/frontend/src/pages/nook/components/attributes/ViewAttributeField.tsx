import { createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../../auth/keycloak";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";
import { FullscreenButton } from "./FullscreenButton";

type ViewConfig = {
	type_id: string;
	filters: Array<{ attribute_id: string; op: string; value: unknown }>;
	display: "list" | "cards" | "table";
};

type ViewNote = {
	id: string;
	title: string;
	attributes: Record<string, unknown>;
};

export function ViewAttributeField(props: {
	attr: TypeAttribute;
	value: Record<string, unknown> | undefined;
	onChange: (v: unknown) => void;
	store: NookStore;
	fullscreen?: boolean;
}) {
	const [results, setResults] = createSignal<ViewNote[]>([]);
	const [resultAttrs, setResultAttrs] = createSignal<TypeAttribute[]>([]);
	const [viewLoading, setViewLoading] = createSignal(false);
	const [typeAttrsForEditor, setTypeAttrsForEditor] = createSignal<
		TypeAttribute[]
	>([]);

	const config = (): ViewConfig => {
		const v = props.value ?? {};
		return {
			type_id: String(v.type_id ?? ""),
			filters: Array.isArray(v.filters)
				? (v.filters as ViewConfig["filters"])
				: [],
			display: (["list", "cards", "table"].includes(String(v.display))
				? String(v.display)
				: "list") as ViewConfig["display"],
		};
	};

	const updateConfig = (patch: Partial<ViewConfig>) => {
		props.onChange({ ...config(), ...patch });
		props.store.setIsDirty(true);
	};

	const loadTypeAttrs = (typeId: string) => {
		if (!typeId) {
			setTypeAttrsForEditor([]);
			setResultAttrs([]);
			return;
		}
		const attrs = props.store.resolveTypeAttributes(typeId);
		const filtered = attrs.filter(
			(a) => !["file", "graph", "view"].includes(a.kind),
		);
		setTypeAttrsForEditor(filtered);
		setResultAttrs(filtered);
	};

	const executeView = async () => {
		const c = config();
		const nookId = props.store.nookId();
		const typeId = c.type_id || "";
		setViewLoading(true);
		try {
			const params = new URLSearchParams();
			// View attribute renderer needs the structured attribute
			// values to render its columns — opt in via ?include=attributes.
			params.set("include", "attributes");
			if (typeId !== "") {
				params.set("type_id", typeId);
				params.set("include_subtypes", "1");
			}
			if (c.filters.length > 0) {
				params.set("attribute_filters", JSON.stringify(c.filters));
			}
			const res = await apiFetch(
				`/api/nooks/${nookId}/notes?${params.toString()}`,
			);
			if (!res.ok) {
				setResults([]);
				return;
			}
			const json = await res.json();
			setResults(
				((json as { notes?: unknown[] }).notes ?? []).map((n: unknown) => {
					const r = n as Record<string, unknown>;
					return {
						id: String(r.id ?? ""),
						title: String(r.title ?? ""),
						attributes:
							typeof r.attributes === "object" && r.attributes !== null
								? (r.attributes as Record<string, unknown>)
								: {},
					};
				}),
			);
			if (c.type_id) void loadTypeAttrs(c.type_id);
		} finally {
			setViewLoading(false);
		}
	};

	// Auto-execute on mount if config has a type
	if (config().type_id) void executeView();

	const isEditing = () => props.store.mode() === "edit";
	const types = () => props.store.noteTypes();

	const opsForKind = (kind: string) => {
		switch (kind) {
			case "number":
				return [
					{ value: "eq", label: "=" },
					{ value: "gte", label: "≥" },
					{ value: "lte", label: "≤" },
					{ value: "gt", label: ">" },
					{ value: "lt", label: "<" },
				];
			case "date":
				return [
					{ value: "date_gte", label: "≥" },
					{ value: "date_lte", label: "≤" },
				];
			case "text":
				return [
					{ value: "eq", label: "=" },
					{ value: "contains", label: "contains" },
					{ value: "starts_with", label: "starts with" },
				];
			case "select":
				return [
					{ value: "eq", label: "=" },
					{ value: "in", label: "in" },
				];
			default:
				return [{ value: "eq", label: "=" }];
		}
	};

	const typeName = () => {
		const tid = config().type_id;
		if (!tid) return "All types";
		return types().find((t) => t.id === tid)?.label ?? tid;
	};

	// Show editor if not configured yet (regardless of edit/view mode)
	const needsSetup = () => !config().type_id;
	const showEditor = () => isEditing() || needsSetup();

	return (
		<div style={{ "margin-top": "8px" }}>
			<Show when={!props.fullscreen}>
				<div
					style={{
						display: "flex",
						"justify-content": "flex-end",
						padding: "0 0 4px",
					}}
				>
					<FullscreenButton attr={props.attr} store={props.store} />
				</div>
			</Show>
			{/* Config — editable in edit mode, summary in view mode */}
			<Show
				when={showEditor()}
				fallback={
					<Show when={config().type_id || config().filters.length > 0}>
						<div
							style={{
								display: "flex",
								gap: "8px",
								"align-items": "center",
								padding: "6px 8px",
								"margin-bottom": "8px",
								border: "1px solid var(--color-border-light)",
								"border-radius": "6px",
								"font-size": "12px",
								color: "var(--color-text-secondary)",
							}}
						>
							<span>{typeName()}</span>
							<span style={{ color: "var(--color-text-muted)" }}>·</span>
							<span>{config().display}</span>
							<Show when={config().filters.length > 0}>
								<span style={{ color: "var(--color-text-muted)" }}>·</span>
								<span>
									{config().filters.length} filter
									{config().filters.length > 1 ? "s" : ""}
								</span>
							</Show>
							<button
								type="button"
								onClick={() => void executeView()}
								style={{
									"margin-left": "auto",
									border: "1px solid var(--color-border-light)",
									"border-radius": "4px",
									padding: "2px 8px",
									background: "var(--color-bg)",
									cursor: "pointer",
									"font-size": "11px",
								}}
							>
								Refresh
							</button>
						</div>
					</Show>
				}
			>
				<div
					style={{
						display: "grid",
						gap: "6px",
						padding: "8px",
						border: "1px solid var(--color-border-medium)",
						"border-radius": "8px",
						background: "var(--color-bg-secondary)",
						"margin-bottom": "8px",
					}}
				>
					<div
						style={{
							"font-size": "11px",
							color: "var(--color-text-secondary)",
						}}
					>
						View settings
					</div>
					<div style={{ display: "flex", gap: "6px" }}>
						<select
							value={config().type_id}
							onChange={(e) => {
								updateConfig({ type_id: e.currentTarget.value, filters: [] });
								void loadTypeAttrs(e.currentTarget.value);
							}}
							style={{ flex: 1, padding: "4px 6px", "font-size": "12px" }}
						>
							<option value="">All types</option>
							<For each={types()}>
								{(t) => <option value={t.id}>{t.label}</option>}
							</For>
						</select>
						<select
							value={config().display}
							onChange={(e) =>
								updateConfig({
									display: e.currentTarget.value as ViewConfig["display"],
								})
							}
							style={{ padding: "4px 6px", "font-size": "12px" }}
						>
							<option value="list">List</option>
							<option value="cards">Cards</option>
							<option value="table">Table</option>
						</select>
					</div>

					<Show when={typeAttrsForEditor().length > 0}>
						<div
							style={{
								"font-size": "11px",
								color: "var(--color-text-secondary)",
							}}
						>
							Filters
						</div>
						<For each={config().filters}>
							{(f, idx) => {
								const attr = () =>
									typeAttrsForEditor().find((a) => a.id === f.attribute_id);
								return (
									<div
										style={{
											display: "flex",
											gap: "4px",
											"align-items": "center",
										}}
									>
										<select
											value={f.attribute_id}
											onChange={(e) => {
												const fs = [...config().filters];
												fs[idx()] = {
													...f,
													attribute_id: e.currentTarget.value,
													op: "eq",
													value: "",
												};
												updateConfig({ filters: fs });
											}}
											style={{ padding: "3px 4px", "font-size": "11px" }}
										>
											<For each={typeAttrsForEditor()}>
												{(a) => <option value={a.id}>{a.name}</option>}
											</For>
										</select>
										<select
											value={f.op}
											onChange={(e) => {
												const fs = [...config().filters];
												fs[idx()] = { ...f, op: e.currentTarget.value };
												updateConfig({ filters: fs });
											}}
											style={{ padding: "3px 4px", "font-size": "11px" }}
										>
											<For each={opsForKind(attr()?.kind ?? "text")}>
												{(o) => <option value={o.value}>{o.label}</option>}
											</For>
										</select>
										<input
											value={String(f.value ?? "")}
											onInput={(e) => {
												const fs = [...config().filters];
												const k = attr()?.kind;
												fs[idx()] = {
													...f,
													value:
														k === "number"
															? Number(e.currentTarget.value) || 0
															: e.currentTarget.value,
												};
												updateConfig({ filters: fs });
											}}
											type={
												attr()?.kind === "number"
													? "number"
													: attr()?.kind === "date"
														? "date"
														: "text"
											}
											style={{
												flex: 1,
												padding: "3px 4px",
												"font-size": "11px",
												"min-width": "50px",
											}}
										/>
										<button
											type="button"
											onClick={() => {
												updateConfig({
													filters: config().filters.filter(
														(_, i) => i !== idx(),
													),
												});
											}}
											style={{
												border: "none",
												background: "none",
												cursor: "pointer",
												color: "var(--color-text-muted)",
											}}
										>
											×
										</button>
									</div>
								);
							}}
						</For>
						<button
							type="button"
							onClick={() => {
								const attrs = typeAttrsForEditor();
								if (attrs.length === 0) return;
								updateConfig({
									filters: [
										...config().filters,
										{ attribute_id: attrs[0].id, op: "eq", value: "" },
									],
								});
							}}
							style={{
								"font-size": "11px",
								padding: "2px 8px",
								border: "1px solid var(--color-border-light)",
								"border-radius": "4px",
								background: "var(--color-bg)",
								cursor: "pointer",
							}}
						>
							+ Filter
						</button>
					</Show>
				</div>
			</Show>

			{/* Results — always shown when config has a type */}
			<Show when={config().type_id}>
				<Show when={viewLoading()}>
					<div
						style={{ color: "var(--color-text-muted)", "font-size": "12px" }}
					>
						Loading...
					</div>
				</Show>
				<Show when={!viewLoading() && results().length > 0}>
					<div
						style={{
							"font-size": "12px",
							color: "var(--color-text-muted)",
							"margin-bottom": "4px",
						}}
					>
						{results().length} notes
					</div>
					{config().display === "table" ? (
						<ViewTable
							notes={results()}
							attrs={resultAttrs()}
							onSelect={(id) => props.store.onNoteLinkClick(id)}
						/>
					) : config().display === "cards" ? (
						<ViewCards
							notes={results()}
							attrs={resultAttrs()}
							onSelect={(id) => props.store.onNoteLinkClick(id)}
						/>
					) : (
						<ViewList
							notes={results()}
							onSelect={(id) => props.store.onNoteLinkClick(id)}
						/>
					)}
				</Show>
				<Show when={!viewLoading() && results().length === 0 && !needsSetup()}>
					<div
						style={{ color: "var(--color-text-muted)", "font-size": "12px" }}
					>
						No matching notes.
					</div>
				</Show>
			</Show>
		</div>
	);
}

function ViewList(props: {
	notes: ViewNote[];
	onSelect: (id: string) => void;
}) {
	return (
		<div style={{ display: "grid", gap: "2px" }}>
			<For each={props.notes}>
				{(n) => (
					<button
						type="button"
						style={{
							padding: "6px 8px",
							border: "1px solid var(--color-border-light)",
							"border-radius": "4px",
							cursor: "pointer",
							"font-size": "13px",
							background: "none",
							font: "inherit",
							color: "inherit",
							"text-align": "left",
							width: "100%",
						}}
						onClick={() => props.onSelect(n.id)}
					>
						{n.title}
					</button>
				)}
			</For>
		</div>
	);
}

function ViewCards(props: {
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
					<button
						type="button"
						style={{
							padding: "10px",
							border: "1px solid var(--color-border-light)",
							"border-radius": "8px",
							cursor: "pointer",
							background: "var(--color-bg)",
							font: "inherit",
							color: "inherit",
							"text-align": "left",
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
										{fmtVal(val, attr)}
									</div>
								);
							}}
						</For>
					</button>
				)}
			</For>
		</div>
	);
}

function ViewTable(props: {
	notes: ViewNote[];
	attrs: TypeAttribute[];
	onSelect: (id: string) => void;
}) {
	const thStyle = {
		"text-align": "left" as const,
		padding: "6px 8px",
		"border-bottom": "2px solid var(--color-border-medium)",
		"font-size": "11px",
		color: "var(--color-text-secondary)",
	};
	const tdStyle = {
		padding: "6px 8px",
		"border-bottom": "1px solid var(--color-border-light)",
	};
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
						<th style={thStyle}>Title</th>
						<For each={props.attrs}>
							{(a) => <th style={thStyle}>{a.name}</th>}
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
								<td style={tdStyle}>{n.title}</td>
								<For each={props.attrs}>
									{(a) => (
										<td
											style={{ ...tdStyle, color: "var(--color-text-muted)" }}
										>
											{fmtVal(n.attributes[a.id], a)}
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

function fmtVal(val: unknown, attr: TypeAttribute): string {
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
