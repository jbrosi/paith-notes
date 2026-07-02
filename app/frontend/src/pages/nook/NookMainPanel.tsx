import { useNavigate } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import { Button } from "../../components/Button";
import { MarkdownView } from "../../components/MarkdownView";
import { useUi } from "../../ui/UiContext";
import notesStyles from "../Notes.module.css";
import { AddLinkForm } from "./components/AddLinkForm";
import { DraftBanner } from "./components/DraftBanner";
import { NoteAttributeFields } from "./components/NoteAttributeFields";
import { TitleSection } from "./components/TitleSection";
import { NookToolbar } from "./NookToolbar";
import type { NookStore } from "./store";

export type NookMainPanelProps = {
	store: NookStore;
	/** When set, only render attributes assigned to this panel key */
	panelFilter?: string;
};

export function NookMainPanel(props: NookMainPanelProps) {
	const store = () => props.store;
	const ui = useUi();
	const navigate = useNavigate();
	const [showAddLink, setShowAddLink] = createSignal(false);
	const [addLinkError, setAddLinkError] = createSignal("");

	createEffect(() => {
		// Close the central add-link form when the user navigates to a
		// different note (otherwise it stays open targeting a stale id).
		void store().selectedId();
		setShowAddLink(false);
		setAddLinkError("");
	});

	// Two-way sync between ui.mode() (toolbar Save button, Nav Edit button)
	// and store.mode() (TitleSection, EditorSection, attribute fields).
	// Previously this was one-way (ui → store) so store-side actions like
	// quickUploadFile that call store.setMode("edit") left ui.mode at
	// "view" — TitleSection rendered editable but the toolbar Save button
	// stayed hidden.
	//
	// Each effect tracks exactly one signal (the initial read) and does
	// the compare + write inside untrack() so the other signal isn't a
	// tracked dep. That avoids a ping-pong loop where the forward effect
	// re-runs on store.mode() change and reverts to the stale ui.mode()
	// (or vice versa).
	createEffect(() => {
		const uiMode = ui.mode();
		untrack(() => {
			if (store().mode() !== uiMode) store().setMode(uiMode);
		});
	});
	createEffect(() => {
		const storeMode = store().mode();
		untrack(() => {
			if (ui.mode() !== storeMode) ui.setMode(storeMode);
		});
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
			{/* UnsavedChangesDialog is rendered at the Nook.tsx root so it
			    shows regardless of which sub-view triggers a pending nav. */}
			<Show
				when={!snapshot()}
				fallback={
					<div style={{ flex: "1", "min-width": "0" }}>
						<div
							style={{
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
							}}
						>
							<div
								style={{
									"font-size": "0.8rem",
									color: "var(--color-text-secondary, #666)",
								}}
							>
								<strong>Archived version v{snapshot()?.version}</strong>
								{" — "}
								{snapshot()?.actor === "ai" ? (
									<span style={{ color: "var(--color-ai, #8b5cf6)" }}>AI</span>
								) : (
									<span>{snapshot()?.userName || "Unknown"}</span>
								)}{" "}
								{snapshot()?.action === "INSERT" ? "created" : "edited"}
								{" on "}
								{formatSnapshotDate(snapshot()?.createdAt ?? "")}
								<span style={{ "margin-left": "8px", opacity: "0.6" }}>
									(read-only)
								</span>
							</div>
							<div style={{ display: "flex", gap: "4px" }}>
								<Button
									variant="secondary"
									size="small"
									onClick={() => {
										const nook = store().nookId();
										const noteId = store().selectedId();
										if (nook && noteId) {
											navigate(
												`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}`,
											);
										}
									}}
								>
									Back to current
								</Button>
								<Button
									variant="secondary"
									size="small"
									onClick={() => {
										const nook = store().nookId();
										const noteId = store().selectedId();
										const ver = snapshot()?.version;
										if (nook && noteId && ver) {
											navigate(
												`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}/compare/${ver}`,
											);
										}
									}}
								>
									Compare with current
								</Button>
							</div>
						</div>
						<h1
							style={{
								"font-size": "1.6rem",
								"font-weight": "700",
								margin: "0 0 1rem",
								color: "var(--color-text-secondary, #444)",
							}}
						>
							{snapshot()?.title || "(untitled)"}
						</h1>
						<NoteAttributeFields
							store={store()}
							typeIdOverride={snapshot()?.typeId}
							valuesOverride={snapshot()?.attributes}
							readonly
							panelFilter={props.panelFilter}
						/>
						<MarkdownView
							content={snapshot()?.content ?? ""}
							resolveEmbeddedImageSrc={(id, nookId) =>
								store().resolveEmbeddedImageSrc(id, nookId)
							}
						/>
					</div>
				}
			>
				<div style={{ flex: "1", "min-width": "0" }}>
					<Show when={conflict()}>
						<div
							style={{
								padding: "10px 14px",
								background: "#fef2f2",
								border: "1px solid #fecaca",
								"border-radius": "6px",
								"margin-bottom": "0.75rem",
								"font-size": "0.85rem",
								color: "#991b1b",
							}}
						>
							<div style={{ "font-weight": "600", "margin-bottom": "4px" }}>
								This note was edited in the meantime
							</div>
							<div style={{ "margin-bottom": "8px", color: "#7f1d1d" }}>
								You were editing version {conflict()?.expectedVersion}, but it's
								now at version {conflict()?.currentVersion}.
							</div>
							<div style={{ display: "flex", gap: "8px" }}>
								<Button
									variant="primary"
									size="small"
									onClick={() => {
										store().resolveConflict();
										void store().saveNote();
									}}
								>
									Overwrite with my changes
								</Button>
								<Button
									variant="secondary"
									size="small"
									onClick={() => {
										store().resolveConflict();
									}}
								>
									Dismiss
								</Button>
							</div>
						</div>
					</Show>
					<Show
						when={
							(store().noteHasUpdate() || store().remoteNoteChanged()) &&
							!conflict()
						}
					>
						<div
							style={{
								padding: "8px 12px",
								background: "var(--color-bg-tertiary, #f0f9ff)",
								border: "1px solid var(--color-primary-border, #bae6fd)",
								"border-radius": "6px",
								"margin-bottom": "0.5rem",
								"font-size": "0.8rem",
								display: "flex",
								"align-items": "center",
								"justify-content": "space-between",
							}}
						>
							<span>This note has been updated by someone else.</span>
							<div style={{ display: "flex", gap: "4px" }}>
								<Button
									variant="secondary"
									size="small"
									onClick={() => store().refreshCurrentNote()}
								>
									Reload
								</Button>
								<Show when={store().remoteNoteChanged()}>
									<Button
										variant="secondary"
										size="small"
										onClick={() => store().dismissRemoteNoteChanged()}
									>
										Dismiss
									</Button>
								</Show>
							</div>
						</div>
					</Show>
					<Show when={store().noteViewers().length > 0}>
						<div
							style={{
								display: "flex",
								"align-items": "center",
								gap: "6px",
								"margin-bottom": "0.5rem",
								"font-size": "0.7rem",
								color: "var(--color-text-muted, #888)",
							}}
						>
							<For each={store().noteViewers()}>
								{(viewer) => (
									<span
										style={{
											display: "inline-block",
											padding: "2px 8px",
											"border-radius": "999px",
											background: "var(--color-primary-bg, #eff6ff)",
											border: "1px solid var(--color-primary-border, #bae6fd)",
											"font-size": "0.65rem",
											"font-weight": "500",
											color: "var(--color-primary, #3b82f6)",
										}}
									>
										{viewer.user_name || "Someone"}
									</span>
								)}
							</For>
							<span>also viewing</span>
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
								// For new notes we want the user to STAY in edit
								// mode after the initial save — they've only just
								// created a shell (title + type), and the whole
								// point of the force-title-first flow is to
								// re-open the note for content editing next.
								const wasNew = store().selectedId() === "";
								await store().saveNote();
								if (!store().error() && !wasNew) ui.setMode("view");
							}}
							onDelete={store().deleteNote}
							onToggleMode={ui.toggleMode}
							onAddLink={() => setShowAddLink((v) => !v)}
						/>
					</div>

					<Show when={showAddLink() && store().selectedId() !== ""}>
						<div
							style={{
								padding: "8px 12px",
								margin: "0 0 12px",
								border: "1px solid var(--color-border-light, #e5e7eb)",
								"border-radius": "6px",
								background: "var(--color-bg-secondary, #f9fafb)",
							}}
						>
							<Show when={addLinkError() !== ""}>
								<pre
									style={{
										color: "var(--color-danger)",
										"white-space": "pre-wrap",
										"font-size": "0.75rem",
										margin: "0 0 6px",
									}}
								>
									{addLinkError()}
								</pre>
							</Show>
							<AddLinkForm
								store={store()}
								nookId={store().nookId()}
								noteId={store().selectedId()}
								onLinkCreated={() => {
									setShowAddLink(false);
									setAddLinkError("");
									store().bumpLinksRevision();
								}}
								onError={setAddLinkError}
							/>
						</div>
					</Show>

					<TitleSection store={store()} />
					<DraftBanner store={store()} />
					<Show
						when={store().selectedId() === "" && store().mode() === "edit"}
						fallback={
							<NoteAttributeFields
								store={store()}
								panelFilter={props.panelFilter}
							/>
						}
					>
						{/* Force title-first for new notes. Content + attributes
						    stay hidden until the note has a real id — the user
						    picks a title (+ optional type), hits Create, then
						    the real editor takes over.

						    Enter in the title input also submits (see
						    TitleSection); this button is the visible fallback
						    for users who miss the Enter shortcut. */}
						<div
							style={{
								display: "flex",
								"align-items": "center",
								"justify-content": "space-between",
								gap: "12px",
								padding: "14px 16px",
								margin: "8px 0 12px",
								border: "1px solid var(--color-border-light, #d1d5db)",
								"border-radius": "6px",
								background: "var(--color-bg-secondary, #f9fafb)",
								"font-size": "0.9rem",
								"flex-wrap": "wrap",
							}}
						>
							<div style={{ color: "var(--color-text-secondary, #6b7280)" }}>
								{store().title().trim() === ""
									? "Title this note to get started — press Enter or click Create."
									: "Ready. Press Enter or click Create."}
							</div>
							<Button
								variant="primary"
								size="small"
								disabled={store().loading() || store().title().trim() === ""}
								onClick={async () => {
									await store().saveNote();
									// New-note create: stay in edit mode (see toolbar
									// onSave for the matching rationale). setMode is
									// not touched here — the store is already in
									// edit mode from newNote().
								}}
								title={
									store().title().trim() === ""
										? "Enter a title first"
										: "Create the note (Enter also works)"
								}
							>
								Create note
							</Button>
						</div>
					</Show>
				</div>
			</Show>
		</>
	);
}
