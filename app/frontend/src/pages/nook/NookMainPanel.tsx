import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useUi } from "../../ui/UiContext";
import notesStyles from "../Notes.module.css";
import { EditorSection } from "./components/EditorSection";
import { FilePanel } from "./components/FilePanel";
import { TitleSection } from "./components/TitleSection";
import type { NotePreviewController } from "./NookDefaultLayout";
import { NookToolbar } from "./NookToolbar";
import type { NookStore } from "./store";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

export type NookMainPanelProps = {
	store: NookStore;
	notePreview?: NotePreviewController;
};

export function NookMainPanel(props: NookMainPanelProps) {
	const store = () => props.store;
	const ui = useUi();

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
					store().saveNote();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown));
	});

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
			<div style={{ flex: "1", "min-width": "0" }}>
				<div class={notesStyles["add-note-container"]}>
					<NookToolbar
						mode={ui.mode()}
						loading={store().loading()}
						title={store().title()}
						selectedId={store().selectedId()}
						canWrite={store().canWrite()}
						onSave={store().saveNote}
						onDelete={store().deleteNote}
						onToggleMode={ui.toggleMode}
					/>
				</div>

				<TitleSection store={store()} />
				<FilePanel store={store()} />
				<EditorSection store={store()} notePreview={props.notePreview} />
			</div>
		</>
	);
}
