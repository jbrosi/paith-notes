import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { NookEmbeddedGraph } from "../NookEmbeddedGraph";
import type { NookStore } from "../store";
import {
	type GraphViewProperties,
	parseGraphProperties,
	serializeGraphProperties,
	type TypeAttribute,
} from "../types";

export function NoteAttributeFields(props: {
	store: NookStore;
	/** Override type ID (e.g. for snapshot view) */
	typeIdOverride?: string;
	/** Override attribute values (e.g. for snapshot view) */
	valuesOverride?: Record<string, unknown>;
	/** Force read-only mode */
	readonly?: boolean;
}) {
	const attributes = createMemo(() => {
		const typeId = props.typeIdOverride ?? props.store.typeId();
		if (!typeId) return [];
		return props.store.resolveTypeAttributes(typeId);
	});

	const noteAttributes = () =>
		(props.valuesOverride ?? props.store.noteAttributes?.() ?? {}) as Record<string, unknown>;

	const setAttr = (attrId: string, value: unknown) => {
		if (props.readonly) return;
		props.store.setNoteAttribute?.(attrId, value);
	};

	const nonInlineKinds = new Set(["file", "graph", "view", "linked_notes", "history"]);
	const simpleAttrs = () =>
		attributes()?.filter((a) => !nonInlineKinds.has(a.kind)) ?? [];
	const fileAttrs = () => attributes()?.filter((a) => a.kind === "file") ?? [];
	const graphAttrs = () =>
		attributes()?.filter((a) => a.kind === "graph") ?? [];
	const viewAttrs = () =>
		attributes()?.filter((a) => a.kind === "view") ?? [];
	const linkedNotesAttrs = () =>
		attributes()?.filter((a) => a.kind === "linked_notes") ?? [];
	const historyAttrs = () =>
		attributes()?.filter((a) => a.kind === "history") ?? [];

	return (
		<>
			<Show when={simpleAttrs().length > 0 || fileAttrs().length > 0}>
				<div
					style={{
						display: "grid",
						gap: "8px",
						padding: "8px 0",
						"border-top": "1px solid var(--color-border-light)",
						"margin-top": "8px",
					}}
				>
					<For each={simpleAttrs()}>
						{(attr) => (
							<AttributeField
								attr={attr}
								value={noteAttributes()[attr.id]}
								onChange={(v) => setAttr(attr.id, v)}
								disabled={props.store.mode() !== "edit"}
							/>
						)}
					</For>
					<For each={fileAttrs()}>
						{(attr) => (
							<FileAttributeField
								attr={attr}
								store={props.store}
								readonly={props.readonly}
							/>
						)}
					</For>
				</div>
			</Show>
			<For each={graphAttrs()}>
				{(attr) => (
					<GraphAttributeField
						attr={attr}
						value={
							noteAttributes()[attr.id] as Record<string, unknown> | undefined
						}
						onChange={(v) => setAttr(attr.id, v)}
						store={props.store}
					/>
				)}
			</For>
			<For each={viewAttrs()}>
				{(attr) => (
					<ViewAttributeField
						attr={attr}
						value={
							noteAttributes()[attr.id] as Record<string, unknown> | undefined
						}
						onChange={(v) => setAttr(attr.id, v)}
						store={props.store}
					/>
				)}
			</For>
			<For each={linkedNotesAttrs()}>
				{(attr) => (
					<LinkedNotesAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
			<For each={historyAttrs()}>
				{(attr) => (
					<HistoryAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
		</>
	);
}

function AttributeField(props: {
	attr: TypeAttribute;
	value: unknown;
	onChange: (v: unknown) => void;
	disabled: boolean;
}) {
	const strVal = () => String(props.value ?? "");
	const numVal = () =>
		typeof props.value === "number" ? props.value : Number(props.value) || 0;

	const labelStyle = {
		"font-size": "12px",
		color: "var(--color-text-secondary)",
		"margin-bottom": "2px",
	};
	const inputStyle = {
		width: "100%",
		padding: "6px 8px",
		"box-sizing": "border-box" as const,
		"font-size": "13px",
	};

	const display = () => (props.attr.config.display as string) ?? "";

	switch (props.attr.kind) {
		case "text":
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					{display() === "paragraph" ? (
						<textarea
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							rows={4}
							style={inputStyle}
						/>
					) : (
						<input
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							style={inputStyle}
						/>
					)}
				</label>
			);

		case "number": {
			if (display() === "rating") {
				const maxVal = Number(props.attr.config.max ?? 5) || 5;
				return (
					<div>
						<div style={labelStyle}>{props.attr.name}</div>
						<div style={{ display: "flex", gap: "2px" }}>
							{Array.from({ length: maxVal }, (_, i) => i + 1).map((n) => (
								<button
									type="button"
									disabled={props.disabled}
									onClick={() => props.onChange(numVal() === n ? 0 : n)}
									style={{
										border: "none",
										background: "none",
										cursor: props.disabled ? "default" : "pointer",
										"font-size": "20px",
										padding: "0 1px",
										color: n <= numVal() ? "var(--seed-warning)" : "var(--color-border-light)",
									}}
								>
									★
								</button>
							))}
							<span style={{ "font-size": "12px", color: "var(--color-text-muted)", "margin-left": "4px", "align-self": "center" }}>
								{numVal() > 0 ? numVal() : ""}
							</span>
						</div>
					</div>
				);
			}
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<input
						type="number"
						value={numVal()}
						onInput={(e) => props.onChange(Number(e.currentTarget.value))}
						disabled={props.disabled}
						style={inputStyle}
					/>
				</label>
			);
		}

		case "boolean":
			return (
				<label
					style={{
						display: "flex",
						"align-items": "center",
						gap: "6px",
						"font-size": "13px",
					}}
				>
					<input
						type="checkbox"
						checked={Boolean(props.value)}
						onChange={(e) => props.onChange(e.currentTarget.checked)}
						disabled={props.disabled}
					/>
					{props.attr.name}
				</label>
			);

		case "date":
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<input
						type="date"
						value={strVal()}
						onInput={(e) => props.onChange(e.currentTarget.value)}
						disabled={props.disabled}
						style={inputStyle}
					/>
				</label>
			);

		case "date_range": {
			const rangeVal = () => {
				if (typeof props.value === "object" && props.value !== null) {
					const v = props.value as { from?: string; to?: string };
					return { from: v.from ?? "", to: v.to ?? "" };
				}
				return { from: "", to: "" };
			};
			return (
				<div>
					<div style={labelStyle}>{props.attr.name}</div>
					<div style={{ display: "flex", gap: "6px" }}>
						<input
							type="date"
							value={rangeVal().from}
							onInput={(e) =>
								props.onChange({ ...rangeVal(), from: e.currentTarget.value })
							}
							disabled={props.disabled}
							style={{ ...inputStyle, flex: 1 }}
						/>
						<span style={{ "align-self": "center", color: "var(--color-text-muted)" }}>to</span>
						<input
							type="date"
							value={rangeVal().to}
							onInput={(e) =>
								props.onChange({ ...rangeVal(), to: e.currentTarget.value })
							}
							disabled={props.disabled}
							style={{ ...inputStyle, flex: 1 }}
						/>
					</div>
				</div>
			);
		}

		case "select": {
			const options = Array.isArray(props.attr.config.options)
				? (props.attr.config.options as string[])
				: [];
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<select
						value={strVal()}
						onChange={(e) => props.onChange(e.currentTarget.value)}
						disabled={props.disabled}
						style={inputStyle}
					>
						<option value="">(none)</option>
						<For each={options}>
							{(opt) => <option value={opt}>{opt}</option>}
						</For>
					</select>
				</label>
			);
		}

		default:
			return null;
	}
}

function FileAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	readonly?: boolean;
}) {
	const [uploading, setUploading] = createSignal(false);
	const [error, setError] = createSignal("");

	const fileData = () => props.store.noteFiles?.()[props.attr.id];
	const filename = () => fileData()?.filename ?? "";
	const contentType = () => fileData()?.mime_type ?? "";
	const size = () => fileData()?.filesize ?? 0;
	const objectKey = () => fileData()?.object_key ?? "";

	const hasFile = () => filename() !== "" && objectKey() !== "";
	const isImage = () => contentType().startsWith("image/");
	const displayMode = () => (props.attr.config.display as string) ?? "download";

	const onUpload = async (file: File) => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId) return;

		setUploading(true);
		setError("");
		try {
			const ext = file.name.includes(".")
				? file.name.slice(file.name.lastIndexOf(".") + 1)
				: "";

			// Step 1: get upload URL
			const initRes = await apiFetch(
				`/api/nooks/${nookId}/notes/${noteId}/attributes/${props.attr.id}/file/upload-url`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						filename: file.name,
						extension: ext,
						filesize: file.size,
						mime_type: file.type,
					}),
				},
			);
			if (!initRes.ok) throw new Error("Failed to get upload URL");
			const initData = await initRes.json();
			const uploadUrl = initData.upload_url as string;
			const uploadId = initData.upload_id as string;

			// Step 2: PUT the file
			const putRes = await fetch(uploadUrl, {
				method: "PUT",
				body: file,
				credentials: "include",
			});
			if (!putRes.ok) throw new Error("File upload failed");

			// Step 3: finalize
			const finRes = await apiFetch(
				`/api/nooks/${nookId}/notes/${noteId}/attributes/${props.attr.id}/file/finalize`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ upload_id: uploadId }),
				},
			);
			if (!finRes.ok) throw new Error("Finalize failed");

			// Reload the note to get updated attributes
			await props.store.loadDetail?.();
		} catch (e) {
			setError(String(e));
		} finally {
			setUploading(false);
		}
	};

	const onDownload = async () => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId) return;

		const res = await apiFetch(
			`/api/nooks/${nookId}/notes/${noteId}/attributes/${props.attr.id}/file/download-url`,
		);
		if (!res.ok) return;
		const data = await res.json();
		window.open(data.download_url as string, "_blank");
	};

	const inlineUrl = () => {
		if (!hasFile()) return "";
		const ext = fileData()?.extension ?? "";
		const key = objectKey();
		if (!key) return "";
		return `/files/${key}${ext ? `.${ext}` : ""}?inline=1`;
	};

	const isEditable = () => !props.readonly && props.store.mode() === "edit";

	return (
		<div>
			<div
				style={{ "font-size": "12px", color: "var(--color-text-secondary)", "margin-bottom": "4px" }}
			>
				{props.attr.name}
			</div>

			<Show when={error() !== ""}>
				<div
					style={{
						color: "var(--color-danger)",
						"font-size": "12px",
						"margin-bottom": "4px",
					}}
				>
					{error()}
				</div>
			</Show>

			<div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
				<Show when={!hasFile() || isEditable()}>
					<input
						type="file"
						disabled={uploading() || !isEditable()}
						onChange={(e) => {
							const f = e.currentTarget.files?.[0];
							if (f) void onUpload(f);
						}}
					/>
				</Show>
				<Show when={hasFile()}>
					<button type="button" onClick={() => void onDownload()}>
						Download
					</button>
					<span style={{ "font-size": "12px", color: "var(--color-text-muted)" }}>
						{filename()} ({Math.round(size() / 1024)}KB)
					</span>
				</Show>
				<Show when={uploading()}>
					<span style={{ "font-size": "12px", color: "var(--color-text-muted)" }}>
						Uploading...
					</span>
				</Show>
			</div>

			<Show
				when={
					hasFile() &&
					(displayMode() === "preview" || displayMode() === "") &&
					isImage()
				}
			>
				<img
					src={inlineUrl()}
					alt={filename()}
					style={{
						"max-width": "100%",
						"max-height": "420px",
						"margin-top": "8px",
						border: "1px solid var(--color-border-light)",
						"border-radius": "8px",
					}}
				/>
			</Show>
			<Show
				when={
					hasFile() &&
					displayMode() === "preview" &&
					contentType() === "application/pdf"
				}
			>
				<iframe
					src={inlineUrl()}
					title={filename()}
					style={{
						width: "100%",
						height: "520px",
						"margin-top": "8px",
						border: "1px solid var(--color-border-light)",
						"border-radius": "8px",
					}}
				/>
			</Show>
		</div>
	);
}

function GraphAttributeField(props: {
	attr: TypeAttribute;
	value: Record<string, unknown> | undefined;
	onChange: (v: unknown) => void;
	store: NookStore;
}) {
	const graphProps = (): GraphViewProperties | null => {
		if (!props.value) return null;
		return parseGraphProperties(props.value as Record<string, unknown>);
	};

	const handleConfigChange = (config: GraphViewProperties) => {
		props.onChange(serializeGraphProperties(config));
		props.store.setIsDirty(true);
	};

	const handleSave = async (config: GraphViewProperties) => {
		props.onChange(serializeGraphProperties(config));
		await props.store.saveNote();
	};

	return (
		<Show when={graphProps()}>
			{(gp) => (
				<NookEmbeddedGraph
					store={props.store}
					graphProps={gp()}
					onConfigChange={handleConfigChange}
					onSave={handleSave}
				/>
			)}
		</Show>
	);
}

// ─── View Attribute ─────────────────────────────────────────────────────────

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

function ViewAttributeField(props: {
	attr: TypeAttribute;
	value: Record<string, unknown> | undefined;
	onChange: (v: unknown) => void;
	store: NookStore;
}) {
	const [results, setResults] = createSignal<ViewNote[]>([]);
	const [resultAttrs, setResultAttrs] = createSignal<TypeAttribute[]>([]);
	const [viewLoading, setViewLoading] = createSignal(false);
	const [typeAttrsForEditor, setTypeAttrsForEditor] = createSignal<TypeAttribute[]>([]);

	const config = (): ViewConfig => {
		const v = props.value ?? {};
		return {
			type_id: String(v.type_id ?? ""),
			filters: Array.isArray(v.filters) ? (v.filters as ViewConfig["filters"]) : [],
			display: (["list", "cards", "table"].includes(String(v.display)) ? String(v.display) : "list") as ViewConfig["display"],
		};
	};

	const updateConfig = (patch: Partial<ViewConfig>) => {
		props.onChange({ ...config(), ...patch });
		props.store.setIsDirty(true);
	};

	const loadTypeAttrs = (typeId: string) => {
		if (!typeId) { setTypeAttrsForEditor([]); setResultAttrs([]); return; }
		const attrs = props.store.resolveTypeAttributes(typeId);
		const filtered = attrs.filter((a) => !["file", "graph", "view"].includes(a.kind));
		setTypeAttrsForEditor(filtered);
		setResultAttrs(filtered);
	};

	const executeView = async () => {
		const c = config();
		const nookId = props.store.nookId();
		const typeId = c.type_id || "all";
		setViewLoading(true);
		try {
			const params = new URLSearchParams();
			if (c.filters.length > 0) {
				params.set("attribute_filters", JSON.stringify(c.filters));
			}
			const qs = params.toString() ? `?${params}` : "";
			const res = await apiFetch(
				`/api/nooks/${nookId}/note-types/${typeId}/notes${qs}`,
			);
			if (!res.ok) { setResults([]); return; }
			const json = await res.json();
			setResults(
				((json as { notes?: unknown[] }).notes ?? []).map((n: unknown) => {
					const r = n as Record<string, unknown>;
					return {
						id: String(r.id ?? ""),
						title: String(r.title ?? ""),
						attributes: typeof r.attributes === "object" && r.attributes !== null
							? (r.attributes as Record<string, unknown>) : {},
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
			case "number": return [
				{ value: "eq", label: "=" }, { value: "gte", label: "≥" },
				{ value: "lte", label: "≤" }, { value: "gt", label: ">" }, { value: "lt", label: "<" },
			];
			case "date": return [
				{ value: "date_gte", label: "≥" }, { value: "date_lte", label: "≤" },
			];
			case "text": return [
				{ value: "eq", label: "=" }, { value: "contains", label: "contains" },
				{ value: "starts_with", label: "starts with" },
			];
			case "select": return [{ value: "eq", label: "=" }, { value: "in", label: "in" }];
			default: return [{ value: "eq", label: "=" }];
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
			{/* Config — editable in edit mode, summary in view mode */}
			<Show when={showEditor()} fallback={
				<Show when={config().type_id || config().filters.length > 0}>
					<div style={{
						display: "flex", gap: "8px", "align-items": "center",
						padding: "6px 8px", "margin-bottom": "8px",
						border: "1px solid var(--color-border-light)", "border-radius": "6px",
						"font-size": "12px", color: "var(--color-text-secondary)",
					}}>
						<span>{typeName()}</span>
						<span style={{ color: "var(--color-text-muted)" }}>·</span>
						<span>{config().display}</span>
						<Show when={config().filters.length > 0}>
							<span style={{ color: "var(--color-text-muted)" }}>·</span>
							<span>{config().filters.length} filter{config().filters.length > 1 ? "s" : ""}</span>
						</Show>
						<button type="button" onClick={() => void executeView()}
							style={{ "margin-left": "auto", border: "1px solid var(--color-border-light)", "border-radius": "4px", padding: "2px 8px", background: "var(--color-bg)", cursor: "pointer", "font-size": "11px" }}>
							Refresh
						</button>
					</div>
				</Show>
			}>
				<div style={{
					display: "grid", gap: "6px", padding: "8px",
					border: "1px solid var(--color-border-medium)", "border-radius": "8px",
					background: "var(--color-bg-secondary)", "margin-bottom": "8px",
				}}>
					<div style={{ "font-size": "11px", color: "var(--color-text-secondary)" }}>View settings</div>
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
							<For each={types()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
						</select>
						<select
							value={config().display}
							onChange={(e) => updateConfig({ display: e.currentTarget.value as ViewConfig["display"] })}
							style={{ padding: "4px 6px", "font-size": "12px" }}
						>
							<option value="list">List</option>
							<option value="cards">Cards</option>
							<option value="table">Table</option>
						</select>
					</div>

					<Show when={typeAttrsForEditor().length > 0}>
						<div style={{ "font-size": "11px", color: "var(--color-text-secondary)" }}>Filters</div>
						<For each={config().filters}>
							{(f, idx) => {
								const attr = () => typeAttrsForEditor().find((a) => a.id === f.attribute_id);
								return (
									<div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
										<select value={f.attribute_id}
											onChange={(e) => {
												const fs = [...config().filters];
												fs[idx()] = { ...f, attribute_id: e.currentTarget.value, op: "eq", value: "" };
												updateConfig({ filters: fs });
											}}
											style={{ padding: "3px 4px", "font-size": "11px" }}
										>
											<For each={typeAttrsForEditor()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
										</select>
										<select value={f.op}
											onChange={(e) => {
												const fs = [...config().filters];
												fs[idx()] = { ...f, op: e.currentTarget.value };
												updateConfig({ filters: fs });
											}}
											style={{ padding: "3px 4px", "font-size": "11px" }}
										>
											<For each={opsForKind(attr()?.kind ?? "text")}>{(o) => <option value={o.value}>{o.label}</option>}</For>
										</select>
										<input value={String(f.value ?? "")}
											onInput={(e) => {
												const fs = [...config().filters];
												const k = attr()?.kind;
												fs[idx()] = { ...f, value: k === "number" ? Number(e.currentTarget.value) || 0 : e.currentTarget.value };
												updateConfig({ filters: fs });
											}}
											type={attr()?.kind === "number" ? "number" : attr()?.kind === "date" ? "date" : "text"}
											style={{ flex: 1, padding: "3px 4px", "font-size": "11px", "min-width": "50px" }}
										/>
										<button type="button" onClick={() => {
											updateConfig({ filters: config().filters.filter((_, i) => i !== idx()) });
										}} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-text-muted)" }}>×</button>
									</div>
								);
							}}
						</For>
						<button type="button" onClick={() => {
							const attrs = typeAttrsForEditor();
							if (attrs.length === 0) return;
							updateConfig({ filters: [...config().filters, { attribute_id: attrs[0].id, op: "eq", value: "" }] });
						}} style={{ "font-size": "11px", padding: "2px 8px", border: "1px solid var(--color-border-light)", "border-radius": "4px", background: "var(--color-bg)", cursor: "pointer" }}>
							+ Filter
						</button>
					</Show>
				</div>
			</Show>

			{/* Results — always shown when config has a type */}
			<Show when={config().type_id}>
				<Show when={viewLoading()}>
					<div style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>Loading...</div>
				</Show>
				<Show when={!viewLoading() && results().length > 0}>
					<div style={{ "font-size": "12px", color: "var(--color-text-muted)", "margin-bottom": "4px" }}>
						{results().length} notes
					</div>
					{config().display === "table" ? (
						<ViewTable notes={results()} attrs={resultAttrs()} onSelect={(id) => props.store.onNoteLinkClick(id)} />
					) : config().display === "cards" ? (
						<ViewCards notes={results()} attrs={resultAttrs()} onSelect={(id) => props.store.onNoteLinkClick(id)} />
					) : (
						<ViewList notes={results()} onSelect={(id) => props.store.onNoteLinkClick(id)} />
					)}
				</Show>
				<Show when={!viewLoading() && results().length === 0 && !needsSetup()}>
					<div style={{ color: "var(--color-text-muted)", "font-size": "12px" }}>No matching notes.</div>
				</Show>
			</Show>
		</div>
	);
}

function ViewList(props: { notes: ViewNote[]; onSelect: (id: string) => void }) {
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

function ViewCards(props: { notes: ViewNote[]; attrs: TypeAttribute[]; onSelect: (id: string) => void }) {
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
										<span style={{ color: "var(--color-text-secondary)" }}>{attr.name}:</span>{" "}{fmtVal(val, attr)}
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

function ViewTable(props: { notes: ViewNote[]; attrs: TypeAttribute[]; onSelect: (id: string) => void }) {
	const thStyle = { "text-align": "left" as const, padding: "6px 8px", "border-bottom": "2px solid var(--color-border-medium)", "font-size": "11px", color: "var(--color-text-secondary)" };
	const tdStyle = { padding: "6px 8px", "border-bottom": "1px solid var(--color-border-light)" };
	return (
		<div style={{ overflow: "auto" }}>
			<table style={{ width: "100%", "border-collapse": "collapse", "font-size": "12px" }}>
				<thead>
					<tr>
						<th style={thStyle}>Title</th>
						<For each={props.attrs}>{(a) => <th style={thStyle}>{a.name}</th>}</For>
					</tr>
				</thead>
				<tbody>
					<For each={props.notes}>
						{(n) => (
							<tr style={{ cursor: "pointer" }} onClick={() => props.onSelect(n.id)}>
								<td style={tdStyle}>{n.title}</td>
								<For each={props.attrs}>
									{(a) => <td style={{ ...tdStyle, color: "var(--color-text-muted)" }}>{fmtVal(n.attributes[a.id], a)}</td>}
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

// ─── Linked Notes Attribute ─────────────────────────────────────────────────

type LinkedNoteItem = {
	noteId: string;
	noteTitle: string;
	nookId?: string;
	typeId?: string;
	predicateLabel?: string;
};

function LinkedNotesAttributeField(props: {
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
			includeMentions: c.include_mentions !== false,
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

		// Mentions
		if (cfg.includeMentions) {
			if (cfg.direction === "outgoing" || cfg.direction === "both") {
				for (const m of props.store.outgoingMentions()) {
					addItem({ noteId: m.noteId, noteTitle: m.noteTitle, nookId: m.nookId });
				}
			}
			if (cfg.direction === "incoming" || cfg.direction === "both") {
				for (const m of props.store.incomingMentions()) {
					addItem({ noteId: m.noteId, noteTitle: m.noteTitle, nookId: m.nookId });
				}
			}
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

// ─── History Attribute ──────────────────────────────────────────────────────

function HistoryAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
}) {
	const limit = () => {
		const v = Number(props.attr.config.limit ?? 5);
		return v > 0 ? v : 5;
	};

	const entries = createMemo(() =>
		props.store.noteHistory().slice(0, limit()),
	);

	const nookId = () => props.store.nookId();
	const noteId = () => props.store.selectedId();
	const historyHref = () => {
		const nook = nookId();
		const note = noteId();
		if (!nook || !note) return "";
		return `/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(note)}/history`;
	};

	return (
		<Show when={entries().length > 0}>
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
				<For each={entries()}>
					{(entry) => {
						const isLink = entry.type === "link";
						const isFile = entry.type === "file";
						const actionLabel = isLink
							? entry.action === "INSERT" ? "linked" : entry.action === "DELETE" ? "unlinked" : "updated link"
							: isFile
								? entry.action === "INSERT" ? "uploaded" : entry.action === "UPDATE" ? "re-uploaded" : "removed file"
								: entry.action === "INSERT" ? "created" : entry.action === "UPDATE" ? "edited" : entry.action === "DELETE" ? "deleted" : entry.action;
						const versionHref = () => {
							if (entry.type !== "note" || !entry.version) return "";
							const nook = nookId();
							const note = noteId();
							if (!nook || !note) return "";
							return `/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(note)}/v/${entry.version}`;
						};
						return (
							<div
								style={{
									display: "flex",
									"align-items": "baseline",
									gap: "4px",
									"font-size": "0.75rem",
									"margin-bottom": "3px",
									"flex-wrap": "wrap",
								}}
							>
								<span style={{ "font-weight": "500", color: "var(--color-text-secondary)" }}>
									{entry.userName || "Unknown"}
								</span>
								<span>{actionLabel}</span>
								<Show when={entry.type === "note" && entry.version && versionHref()}>
									<a
										href={versionHref()}
										style={{
											padding: "1px 6px",
											"border-radius": "999px",
											background: "var(--color-bg-tertiary, #f3f4f6)",
											"font-size": "0.65rem",
											"font-weight": "500",
											color: "var(--color-text-muted)",
											"text-decoration": "none",
										}}
									>
										v{entry.version}
									</a>
								</Show>
								<Show when={isFile && entry.filename}>
									<span style={{ "font-size": "0.65rem", color: "var(--color-text-muted)" }}>
										{entry.filename}
									</span>
								</Show>
								<span
									style={{
										"font-size": "0.65rem",
										color: "var(--color-text-muted)",
										"margin-left": "auto",
									}}
								>
									{formatTimeAgo(entry.createdAt)}
								</span>
							</div>
						);
					}}
				</For>
				<Show when={props.store.noteHistory().length > limit()}>
					<a
						href={historyHref()}
						style={{
							"font-size": "0.7rem",
							color: "var(--link-color, #0066cc)",
							"text-decoration": "none",
							"margin-top": "4px",
							display: "inline-block",
						}}
					>
						Show full history
					</a>
				</Show>
			</div>
		</Show>
	);
}

function formatTimeAgo(iso: string): string {
	try {
		const d = new Date(iso);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return "just now";
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffH = Math.floor(diffMin / 60);
		if (diffH < 24) return `${diffH}h ago`;
		const diffD = Math.floor(diffH / 24);
		if (diffD < 7) return `${diffD}d ago`;
		return d.toLocaleDateString();
	} catch {
		return iso;
	}
}
