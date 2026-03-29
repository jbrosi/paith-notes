import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { NoteTypeSearchSelect } from "../../../components/NoteTypeSearchSelect";
import type { NookStore } from "../store";

export function TitleSection(props: { store: NookStore }) {
	const [editingTitle, setEditingTitle] = createSignal(false);
	let titleInputRef: HTMLInputElement | undefined;

	const isVisible = () =>
		props.store.type() !== "file" ||
		(props.store.fileFilename() !== "" && !props.store.fileUploadInProgress());

	const types = createMemo(() => props.store.noteTypes());

	const primaryTypeLabel = createMemo(() => {
		const tid = props.store.typeId().trim();
		if (tid === "") return "";
		return props.store.noteTypes().find((t) => t.id === tid)?.label ?? "";
	});

	const activateTitle = () => {
		if (props.store.mode() !== "edit") return;
		setEditingTitle(true);
		window.setTimeout(() => {
			titleInputRef?.focus();
			titleInputRef?.select();
		}, 0);
	};

	// Reset editing state when mode changes to view or note changes
	createEffect(() => {
		if (props.store.mode() === "view") setEditingTitle(false);
	});
	createEffect(() => {
		void props.store.selectedId();
		setEditingTitle(false);
	});

	return (
		<Show when={isVisible()}>
			<div style={{ "margin-bottom": "0.75rem" }}>
				{/* Title — h1 in view/idle, inline input when editing */}
				<Show
					when={props.store.mode() === "edit" && editingTitle()}
					fallback={
						<h1
							onClick={activateTitle}
							onKeyDown={(e) => {
								if (e.key === "Enter") activateTitle();
							}}
							style={{
								margin: "0",
								"font-size": "1.6rem",
								"font-weight": "700",
								"line-height": "1.25",
								cursor: props.store.mode() === "edit" ? "text" : "default",
								color: props.store.title().trim() === "" ? "#aaa" : "inherit",
								padding: "1px 0",
								display: "flex",
								"align-items": "baseline",
								gap: "6px",
							}}
						>
							<span>{props.store.title().trim() || "(untitled)"}</span>
							<Show
								when={props.store.mode() === "edit" && props.store.isDirty()}
							>
								<span
									title="Unsaved changes — click Save or press Ctrl+S"
									style={{
										"font-size": "0.6rem",
										"font-weight": "400",
										color: "#0969da",
										"vertical-align": "super",
										"line-height": "1",
										cursor: "default",
										"flex-shrink": "0",
									}}
								>
									●
								</span>
							</Show>
						</h1>
					}
				>
					<input
						ref={titleInputRef}
						type="text"
						value={props.store.title()}
						onInput={(e) => props.store.setTitle(e.currentTarget.value)}
						onBlur={() => setEditingTitle(false)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === "Escape")
								setEditingTitle(false);
						}}
						style={{
							width: "100%",
							"font-size": "1.6rem",
							"font-weight": "700",
							"line-height": "1.25",
							border: "none",
							"border-bottom": "2px solid #0969da",
							outline: "none",
							padding: "0 0 1px",
							"box-sizing": "border-box",
							background: "transparent",
							"font-family": "inherit",
						}}
					/>
				</Show>

				{/* Type badge / selector */}
				<div style={{ "margin-top": "6px" }}>
					<Show
						when={props.store.mode() === "edit"}
						fallback={
							<span
								style={{
									display: "inline-block",
									padding: "2px 10px",
									"border-radius": "999px",
									border: "1px solid #d0d7de",
									background: "#f6f8fa",
									"font-size": "12px",
									"font-weight": "500",
									color: primaryTypeLabel().trim() !== "" ? "#444" : "#999",
								}}
							>
								{primaryTypeLabel().trim() !== ""
									? primaryTypeLabel()
									: "No type"}
							</span>
						}
					>
						<NoteTypeSearchSelect
							value={props.store.typeId()}
							onChange={(id) => props.store.setTypeId(id)}
							types={types()}
							placeholder="(no type)"
						/>
					</Show>
				</div>
			</div>
		</Show>
	);
}
