import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { NoteTypeSearchSelect } from "../../../components/NoteTypeSearchSelect";
import type { NookStore } from "../store";
import styles from "./TitleSection.module.css";

export function TitleSection(props: { store: NookStore }) {
	const navigate = useNavigate();
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

	createEffect(() => {
		if (props.store.mode() === "view") setEditingTitle(false);
	});
	createEffect(() => {
		const id = props.store.selectedId();
		if (id === "" && props.store.mode() === "edit") {
			setEditingTitle(true);
			window.setTimeout(() => {
				titleInputRef?.focus();
				titleInputRef?.select();
			}, 50);
		} else {
			setEditingTitle(false);
		}
	});

	return (
		<Show when={isVisible()}>
			<div class={styles.wrapper}>
				<Show
					when={props.store.mode() === "edit" && editingTitle()}
					fallback={
						<h1
							onClick={activateTitle}
							onKeyDown={(e) => {
								if (e.key === "Enter") activateTitle();
							}}
							class={`${styles.heading} ${props.store.mode() === "edit" ? styles.headingEditable : ""} ${props.store.title().trim() === "" ? styles.headingEmpty : ""}`}
						>
							<span>{props.store.title().trim() || "(untitled)"}</span>
							<Show
								when={props.store.mode() === "edit" && props.store.isDirty()}
							>
								<span
									class={styles.dirtyDot}
									title="Unsaved changes — click Save or press Ctrl+S"
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
						class={styles.titleInput}
					/>
				</Show>

				<div class={styles.typeRow}>
					<Show
						when={props.store.mode() === "edit"}
						fallback={
							<span
								class={`${styles.typeBadge} ${primaryTypeLabel().trim() === "" ? styles.typeBadgeEmpty : ""}`}
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
					<Show
						when={
							props.store.mode() === "view" &&
							props.store.noteHistory().length > 0
						}
					>
						<button
							type="button"
							class={styles.versionBadge}
							onClick={() => {
								const nook = props.store.nookId();
								const noteId = props.store.selectedId();
								if (nook && noteId) {
									navigate(
										`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}/history`,
									);
								}
							}}
							title="View full change history"
						>
							v{props.store.noteHistory()[0]?.version ?? 0}
						</button>
					</Show>
					<Show
						when={props.store.mode() === "view" && props.store.viewCount() > 0}
					>
						<span class={styles.versionBadge} title="Total views">
							{props.store.viewCount()}{" "}
							{props.store.viewCount() === 1 ? "view" : "views"}
						</span>
					</Show>
				</div>
			</div>
		</Show>
	);
}
