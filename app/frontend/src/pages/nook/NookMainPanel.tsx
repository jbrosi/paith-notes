import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { MarkdownView } from "../../components/MarkdownView";
import { Button } from "../../components/Button";
import { useUi } from "../../ui/UiContext";
import notesStyles from "../Notes.module.css";
import { EditorSection } from "./components/EditorSection";
import { FilePanel } from "./components/FilePanel";
import { TitleSection } from "./components/TitleSection";
import { NookToolbar } from "./NookToolbar";
import type { NookStore } from "./store";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

export type NookMainPanelProps = {
	store: NookStore;
};

export function NookMainPanel(props: NookMainPanelProps) {
	const store = () => props.store;
	const ui = useUi();
	const navigate = useNavigate();

	createEffect(() => {
		store().setMode(ui.mode());
	});

	onMount(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				if (
					ui.mode() === "edit" &&
					store().selectedId() !== "" &&
					store().canWrite()
				) {
					e.preventDefault();
					void store()
						.saveNote()
						.then(() => {
							if (!store().error()) ui.setMode("view");
						});
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown));
	});

	const snapshot = createMemo(() => store().snapshotData());
	const conflict = createMemo(() => store().conflictError());

	const formatSnapshotDate = (iso: string) => {
		try {
			const d = new Date(iso);
			return d.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	};

	return (
		<>
			<Show when={store().pendingNav() !== null}>
				<Portal>
					<UnsavedChangesDialog
						onSave={() => void store().confirmPendingNav(true)}
						onDiscard={() => void store().confirmPendingNav(false)}
						onCancel={() => store().cancelPendingNav()}
					/>
				</Portal>
			</Show>
			<Show
				when={!snapshot()}
				fallback={
					<div style={{ flex: "1", "min-width": "0" }}>
						<div style={{
							padding: "10px 14px",
							background: "var(--color-bg-tertiary, #f9fafb)",
							border: "1px solid var(--color-border-medium, #e5e7eb)",
							"border-radius": "6px",
							"margin-bottom": "1rem",
							display: "flex",
							"align-items": "center",
							"justify-content": "space-between",
							gap: "12px",
							"flex-wrap": "wrap",
						}}>
							<div style={{ "font-size": "0.8rem", color: "var(--color-text-secondary, #666)" }}>
								<strong>Archived version v{snapshot()!.version}</strong>
								{" — "}
								{snapshot()!.actor === "ai" ? (
									<span style={{ color: "var(--color-ai, #8b5cf6)" }}>AI</span>
								) : (
									<span>{snapshot()!.userName || "Unknown"}</span>
								)}
								{" "}
								{snapshot()!.action === "INSERT" ? "created" : "edited"}
								{" on "}
								{formatSnapshotDate(snapshot()!.createdAt)}
								<span style={{ "margin-left": "8px", opacity: "0.6" }}>
									(read-only)
								</span>
							</div>
							<Button variant="secondary" size="small" onClick={() => {
								const nook = store().nookId();
								const noteId = store().selectedId();
								if (nook && noteId) {
									navigate(`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}`);
								}
							}}>
								Back to current
							</Button>
						</div>
						<h1 style={{
							"font-size": "1.6rem",
							"font-weight": "700",
							margin: "0 0 1rem",
							color: "var(--color-text-secondary, #444)",
						}}>
							{snapshot()!.title || "(untitled)"}
						</h1>
						<MarkdownView content={snapshot()!.content} />
					</div>
				}
			>
				<div style={{ flex: "1", "min-width": "0" }}>
					<Show when={conflict()}>
						<div style={{
							padding: "10px 14px",
							background: "#fef2f2",
							border: "1px solid #fecaca",
							"border-radius": "6px",
							"margin-bottom": "0.75rem",
							"font-size": "0.85rem",
							color: "#991b1b",
						}}>
							<div style={{ "font-weight": "600", "margin-bottom": "4px" }}>
								This note was edited in the meantime
							</div>
							<div style={{ "margin-bottom": "8px", color: "#7f1d1d" }}>
								You were editing version {conflict()!.expectedVersion}, but it's now at version {conflict()!.currentVersion}.
							</div>
							<div style={{ display: "flex", gap: "8px" }}>
								<Button variant="primary" size="small" onClick={() => {
									store().resolveConflict();
									void store().saveNote();
								}}>
									Overwrite with my changes
								</Button>
								<Button variant="secondary" size="small" onClick={() => {
									store().resolveConflict();
								}}>
									Dismiss
								</Button>
							</div>
						</div>
					</Show>
					<div class={notesStyles["add-note-container"]}>
						<NookToolbar
							mode={ui.mode()}
							loading={store().loading()}
							title={store().title()}
							selectedId={store().selectedId()}
							canWrite={store().canWrite()}
							onSave={async () => {
								await store().saveNote();
								if (!store().error()) ui.setMode("view");
							}}
							onDelete={store().deleteNote}
							onToggleMode={ui.toggleMode}
						/>
					</div>

					<TitleSection store={store()} />
					<FilePanel store={store()} />
					<EditorSection store={store()} />
				</div>
			</Show>
		</>
	);
}
