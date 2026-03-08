import { createEffect, createMemo, Show } from "solid-js";
import { useUi } from "../../ui/UiContext";
import notesStyles from "../Notes.module.css";
import { EditorSection } from "./components/EditorSection";
import { FilePanel } from "./components/FilePanel";
import { PrimaryTypeSelect } from "./components/PrimaryTypeSelect";
import { TitleSection } from "./components/TitleSection";
import { NookNoteLinksPanel } from "./NookNoteLinksPanel";
import { NookToolbar } from "./NookToolbar";
import type { NookStore } from "./store";

export type NookMainPanelProps = {
	store: NookStore;
	showMarkdown: boolean;
	onToggleMarkdown: () => void;
};

export function NookMainPanel(props: NookMainPanelProps) {
	const store = () => props.store;
	const ui = useUi();
	const primaryTypeLabel = createMemo(() => {
		const tid = store().typeId().trim();
		if (tid === "") return "";
		const t = store()
			.noteTypes()
			.find((x) => x.id === tid);
		return t ? t.label : "";
	});

	createEffect(() => {
		store().setMode(ui.mode());
	});

	return (
		<div style={{ flex: "1", "min-width": "0" }}>
			<div class={notesStyles["add-note-container"]}>
				<NookToolbar
					nookId={store().nookId()}
					mode={ui.mode()}
					loading={store().loading()}
					title={store().title()}
					selectedId={store().selectedId()}
					notes={store().allNotes()}
					noteTypes={store().noteTypes()}
					mentionTargetId={store().mentionTargetId()}
					mentionEmbedImage={store().mentionEmbedImage()}
					mentionCanEmbedImage={store().mentionCanEmbedImage()}
					onRefresh={() => void store().refreshCurrentNote()}
					onChangeMentionTargetId={store().setMentionTargetId}
					onChangeMentionEmbedImage={store().setMentionEmbedImage}
					onInsertMention={store().insertMention}
					onSave={store().saveNote}
					onDelete={store().deleteNote}
				/>
			</div>

			<button
				type="button"
				onClick={props.onToggleMarkdown}
				style={{ "margin-bottom": "0.5rem" }}
			>
				{props.showMarkdown ? "Hide" : "Show"} markdown
			</button>
			<Show when={props.showMarkdown}>
				<textarea
					readOnly
					value={store().content()}
					style={{
						width: "100%",
						height: "180px",
						"font-family": "monospace",
						"box-sizing": "border-box",
						padding: "8px",
						"margin-bottom": "1rem",
					}}
				/>
			</Show>

			<Show when={store().mode() === "edit"}>
				<PrimaryTypeSelect store={store()} />
			</Show>

			<FilePanel store={store()} />
			<TitleSection store={store()} primaryTypeLabel={primaryTypeLabel} />
			<EditorSection store={store()} />

			<Show when={store().selectedId() !== ""}>
				<NookNoteLinksPanel store={store()} />
			</Show>
		</div>
	);
}
