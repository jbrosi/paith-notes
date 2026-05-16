import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
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
		</>
	);
}
