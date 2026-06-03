import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { MarkdownView } from "../../../components/MarkdownView";
import { MentionDropdown } from "../../../components/MentionDropdown";
import type {
	EditorHandle,
	MentionStartInfo,
} from "../../../components/MilkdownEditor";
import { MilkdownEditor } from "../../../components/MilkdownEditor";
import { useNotePreview } from "../NookContext";
import type { NookStore } from "../store";

export function EditorSection(props: { store: NookStore }) {
	const notePreview = useNotePreview();
	const [mentionActive, setMentionActive] = createSignal(false);
	const [mentionPos, setMentionPos] = createSignal({ x: 0, y: 0 });
	const [mentionQuery, setMentionQuery] = createSignal("");
	let mentionFrom = 0;
	let mentionQueryLen = 0;
	let mentionEmbed = false;
	let editorHandle: EditorHandle | null = null;

	const handleMentionStart = (info: MentionStartInfo) => {
		mentionFrom = info.from;
		mentionEmbed = info.embed;
		mentionQueryLen = 0;
		setMentionQuery("");
		setMentionPos({ x: info.rect.left, y: info.rect.bottom });
		setMentionActive(true);
	};

	const handleMentionQuery = (query: string) => {
		mentionQueryLen = query.length;
		setMentionQuery(query);
	};

	const handleMentionCancel = () => {
		setMentionActive(false);
		setMentionQuery("");
		mentionFrom = 0;
		mentionQueryLen = 0;
		mentionEmbed = false;
	};

	const resolveNoteTitle = (id: string): string | undefined =>
		props.store.allNotes().find((n) => n.id === id)?.title;

	const handleNoteSelect = (noteId: string, noteTitle: string) => {
		if (!editorHandle) return;
		const from = mentionFrom;
		const triggerLen = mentionEmbed ? 2 : 1;
		const to = mentionFrom + triggerLen + mentionQueryLen;
		const href = mentionEmbed ? `note:${noteId}` : `note-ref:${noteId}`;
		editorHandle.insertMentionAt(from, to, noteTitle, href, mentionEmbed);
		setMentionActive(false);
		setMentionQuery("");
		mentionFrom = 0;
		mentionQueryLen = 0;
		mentionEmbed = false;
	};

	const isViewMode = () => props.store.mode() !== "edit";

	return (
		<Show when={true}>
			<Show
				when={isViewMode()}
				fallback={
					<>
						<MilkdownEditor
							value={props.store.content()}
							onChange={props.store.setContent}
							readonly={false}
							onNoteLinkClick={(id) => {
								notePreview?.dismiss();
								void props.store.onNoteLinkClick(id);
							}}
							onNoteLinkPopup={(noteId, x, y) => {
								if (!notePreview) return;
								notePreview.show(noteId, x, y, {
									immediate: true,
									onOpen: (id) => void props.store.onNoteLinkClick(id),
									actions: [
										{
											label: "Remove link",
											danger: true,
											onClick: () => editorHandle?.removeLinkAt(x, y),
										},
									],
								});
							}}
							resolveEmbeddedImageSrc={(id) =>
								props.store.resolveEmbeddedImageSrc(id)
							}
							uploadEmbeddedImage={(f) => props.store.uploadEmbeddedImage(f)}
							resolveNoteTitle={resolveNoteTitle}
							onMentionStart={handleMentionStart}
							onMentionQuery={handleMentionQuery}
							onMentionCancel={handleMentionCancel}
							onEditorReady={(handle) => {
								editorHandle = handle;
							}}
						/>

						<Show when={mentionActive()}>
							<Portal mount={document.body}>
								<MentionDropdown
									x={mentionPos().x}
									y={mentionPos().y}
									query={mentionQuery()}
									nookId={props.store.nookId()}
									noteTypes={props.store.noteTypes()}
									onSelect={handleNoteSelect}
									onFillQuery={(fill) => {
										editorHandle?.replaceQuery(fill);
									}}
									onClose={handleMentionCancel}
								/>
							</Portal>
						</Show>
					</>
				}
			>
				<MarkdownView
					content={props.store.content()}
					resolveEmbeddedImageSrc={(id) =>
						props.store.resolveEmbeddedImageSrc(id)
					}
				/>
			</Show>
		</Show>
	);
}

