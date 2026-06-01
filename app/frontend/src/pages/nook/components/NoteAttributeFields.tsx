import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { NookEmbeddedGraph } from "../NookEmbeddedGraph";
import type { NookStore } from "../store";
import {
	type GraphViewProperties,
	parseGraphProperties,
	serializeGraphProperties,
	type TypeAttribute,
	TypeAttributesListResponseSchema,
} from "../types";

export function NoteAttributeFields(props: { store: NookStore }) {
	const fetchAttributes = async () => {
		const nookId = props.store.nookId();
		const typeId = props.store.typeId();
		if (!nookId || !typeId) return [];
		const res = await apiFetch(
			`/api/nooks/${nookId}/note-types/${typeId}/attributes`,
		);
		if (!res.ok) return [];
		const json = await res.json();
		return TypeAttributesListResponseSchema.parse(json).attributes;
	};

	const [attributes] = createResource(
		() => `${props.store.nookId()}|${props.store.typeId()}`,
		fetchAttributes,
	);

	const noteAttributes = () =>
		(props.store.noteAttributes?.() ?? {}) as Record<string, unknown>;

	const setAttr = (attrId: string, value: unknown) => {
		props.store.setNoteAttribute?.(attrId, value);
	};

	const simpleAttrs = () =>
		attributes()?.filter((a) => a.kind !== "file" && a.kind !== "graph") ?? [];
	const fileAttrs = () => attributes()?.filter((a) => a.kind === "file") ?? [];
	const graphAttrs = () =>
		attributes()?.filter((a) => a.kind === "graph") ?? [];

	return (
		<>
			<Show when={simpleAttrs().length > 0 || fileAttrs().length > 0}>
				<div
					style={{
						display: "grid",
						gap: "8px",
						padding: "8px 0",
						"border-top": "1px solid #eee",
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
								value={
									noteAttributes()[attr.id] as
										| Record<string, unknown>
										| undefined
								}
								store={props.store}
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
		color: "#666",
		"margin-bottom": "2px",
	};
	const inputStyle = {
		width: "100%",
		padding: "6px 8px",
		"box-sizing": "border-box" as const,
		"font-size": "13px",
	};

	switch (props.attr.kind) {
		case "text":
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<input
						value={strVal()}
						onInput={(e) => props.onChange(e.currentTarget.value)}
						disabled={props.disabled}
						style={inputStyle}
					/>
				</label>
			);

		case "number":
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
						<span style={{ "align-self": "center", color: "#999" }}>to</span>
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
	value: Record<string, unknown> | undefined;
	store: NookStore;
}) {
	const [uploading, setUploading] = createSignal(false);
	const [error, setError] = createSignal("");

	const filename = () => String(props.value?.filename ?? "");
	const contentType = () => String(props.value?.content_type ?? "");
	const size = () => Number(props.value?.size ?? 0);
	const storageKey = () => String(props.value?.storage_key ?? "");

	const hasFile = () => filename() !== "" && storageKey() !== "";
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
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (!nookId || !noteId || !hasFile()) return "";
		const ext = String(props.value?.extension ?? "");
		const key = storageKey();
		if (!key) return "";
		return `/files/${key}${ext ? `.${ext}` : ""}?inline=1`;
	};

	return (
		<div>
			<div
				style={{ "font-size": "12px", color: "#666", "margin-bottom": "4px" }}
			>
				{props.attr.name}
			</div>

			<Show when={error() !== ""}>
				<div
					style={{
						color: "#b00020",
						"font-size": "12px",
						"margin-bottom": "4px",
					}}
				>
					{error()}
				</div>
			</Show>

			<div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
				<Show when={!hasFile() || props.store.mode() === "edit"}>
					<input
						type="file"
						disabled={uploading() || props.store.mode() !== "edit"}
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
					<span style={{ "font-size": "12px", color: "#888" }}>
						{filename()} ({Math.round(size() / 1024)}KB)
					</span>
				</Show>
				<Show when={uploading()}>
					<span style={{ "font-size": "12px", color: "#888" }}>
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
						border: "1px solid #eee",
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
						border: "1px solid #eee",
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
