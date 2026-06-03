import { createSignal, Show } from "solid-js";
import { apiFetch } from "../../../../auth/keycloak";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

export function FileAttributeField(props: {
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
