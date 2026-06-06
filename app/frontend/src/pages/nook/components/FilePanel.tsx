import { Show } from "solid-js";
import type { NookStore } from "../store";

export function FilePanel(props: { store: NookStore }) {
	return (
		<Show when={props.store.type() === "file"}>
			<div
				style={{
					display: "flex",
					gap: "8px",
					"align-items": "center",
				}}
			>
				<Show when={props.store.fileFilename() === ""}>
					<input
						type="file"
						disabled={props.store.mode() !== "edit"}
						onChange={(e) => {
							const f = e.currentTarget.files?.[0];
							if (f) void props.store.uploadFile(f);
						}}
					/>
				</Show>
				<button
					type="button"
					onClick={() => void props.store.downloadFile()}
					disabled={
						props.store.selectedId() === "" || props.store.fileFilename() === ""
					}
				>
					Download
				</button>
			</div>

			<Show when={props.store.fileFilename() !== ""}>
				<div
					style={{
						"margin-top": "0.5rem",
						padding: "8px 10px",
						border: "1px solid #eee",
						"border-radius": "8px",
						background: "#fafafa",
						color: "#444",
						"font-size": "13px",
					}}
				>
					<div style={{ "font-weight": "600", "margin-bottom": "4px" }}>
						File details
					</div>
					<div
						style={{
							display: "grid",
							"grid-template-columns": "140px 1fr",
							gap: "4px 10px",
						}}
					>
						<div style={{ color: "#666" }}>Filename</div>
						<div style={{ "word-break": "break-word" }}>
							{props.store.fileFilename()}
						</div>
						<div style={{ color: "#666" }}>Content-Type</div>
						<div>
							{props.store.fileContentType() ||
								props.store.fileMimeType() ||
								""}
						</div>
						<div style={{ color: "#666" }}>Size</div>
						<div>{props.store.fileFilesize()}</div>
						<div style={{ color: "#666" }}>Extension</div>
						<div>{props.store.fileExtension()}</div>
						<Show when={props.store.fileChecksum() !== ""}>
							<div style={{ color: "#666" }}>Checksum</div>
							<div style={{ "word-break": "break-all" }}>
								{props.store.fileChecksum()}
							</div>
						</Show>
					</div>
				</div>
			</Show>

			<Show
				when={
					props.store.selectedId() !== "" &&
					!props.store.fileUploadInProgress() &&
					props.store.fileInlineUrl() !== ""
				}
			>
				<div style={{ "margin-top": "0.5rem" }}>
					<Show
						when={(props.store.fileContentType() || props.store.fileMimeType())
							.toLowerCase()
							.startsWith("image/")}
					>
						<img
							src={props.store.fileInlineUrl()}
							alt={props.store.fileFilename()}
							style={{
								"max-width": "100%",
								"max-height": "420px",
								border: "1px solid #eee",
								"border-radius": "8px",
							}}
						/>
					</Show>
					<Show
						when={
							(
								props.store.fileContentType() || props.store.fileMimeType()
							).toLowerCase() === "application/pdf"
						}
					>
						<iframe
							src={props.store.fileInlineUrl()}
							title={props.store.fileFilename()}
							style={{
								width: "100%",
								height: "520px",
								border: "1px solid #eee",
								"border-radius": "8px",
							}}
						/>
					</Show>
					<Show
						when={
							!(props.store.fileContentType() || props.store.fileMimeType())
								.toLowerCase()
								.startsWith("image/") &&
							(
								props.store.fileContentType() || props.store.fileMimeType()
							).toLowerCase() !== "application/pdf"
						}
					>
						<div style={{ color: "#666" }}>
							Preview not available for this file type.
						</div>
					</Show>
				</div>
			</Show>
		</Show>
	);
}
