import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { LinkPopup } from "../../../components/LinkPopup";
import { MentionDropdown } from "../../../components/MentionDropdown";
import type {
	EditorHandle,
	MentionStartInfo,
} from "../../../components/MilkdownEditor";
import { MilkdownEditor } from "../../../components/MilkdownEditor";
import type { NookStore } from "../store";

export function EditorSection(props: { store: NookStore }) {
	const [linkPopupActive, setLinkPopupActive] = createSignal(false);
	const [linkPopupPos, setLinkPopupPos] = createSignal({ x: 0, y: 0 });
	const [linkPopupNoteId, setLinkPopupNoteId] = createSignal("");

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

	const handleNoteLinkPopup = (noteId: string, x: number, y: number) => {
		setLinkPopupNoteId(noteId);
		setLinkPopupPos({ x, y });
		setLinkPopupActive(true);
	};

	const resolveNoteTitle = (id: string): string | undefined =>
		props.store.allNotes().find((n) => n.id === id)?.title;

	const resolveNoteTypeLabel = (id: string): string | undefined => {
		const typeId = props.store.allNotes().find((n) => n.id === id)?.typeId;
		if (!typeId) return undefined;
		return props.store.noteTypes().find((t) => t.id === typeId)?.label;
	};

	const handleNoteSelect = (noteId: string, noteTitle: string) => {
		if (!editorHandle) return;
		const from = mentionFrom;
		// embed mode: trigger is "!@" (2 chars); normal: "@" (1 char)
		const triggerLen = mentionEmbed ? 2 : 1;
		const to = mentionFrom + triggerLen + mentionQueryLen;
		// Non-embed uses note-ref: so it gets stored as [[note:uuid]] (wiki link with auto-updating title)
		// Embed uses note: so it stays as a regular image embed
		const href = mentionEmbed ? `note:${noteId}` : `note-ref:${noteId}`;
		editorHandle.insertMentionAt(from, to, noteTitle, href, mentionEmbed);
		setMentionActive(false);
		setMentionQuery("");
		mentionFrom = 0;
		mentionQueryLen = 0;
		mentionEmbed = false;
	};

	return (
		<Show
			when={
				props.store.type() !== "file" ||
				(props.store.fileFilename() !== "" &&
					!props.store.fileUploadInProgress())
			}
		>
			<div
				style={{
					border: "1px solid #eee",
					"border-radius": "6px",
				}}
			>
				<MilkdownEditor
					value={props.store.content()}
					onChange={props.store.setContent}
					readonly={props.store.mode() !== "edit"}
					onNoteLinkClick={(id) => void props.store.onNoteLinkClick(id)}
					resolveEmbeddedImageSrc={(id) =>
						props.store.resolveEmbeddedImageSrc(id)
					}
					uploadEmbeddedImage={(f) => props.store.uploadEmbeddedImage(f)}
					resolveNoteTitle={resolveNoteTitle}
					onNoteLinkPopup={handleNoteLinkPopup}
					onMentionStart={handleMentionStart}
					onMentionQuery={handleMentionQuery}
					onMentionCancel={handleMentionCancel}
					onEditorReady={(handle) => {
						editorHandle = handle;
					}}
				/>
			</div>

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

			<Show when={linkPopupActive()}>
				<Portal mount={document.body}>
					<LinkPopup
						x={linkPopupPos().x}
						y={linkPopupPos().y}
						nookId={props.store.nookId()}
						noteId={linkPopupNoteId()}
						noteTitle={resolveNoteTitle(linkPopupNoteId())}
						noteType={resolveNoteTypeLabel(linkPopupNoteId())}
						onOpen={() => void props.store.onNoteLinkClick(linkPopupNoteId())}
						onRemove={() =>
							editorHandle?.removeLinkAt(linkPopupPos().x, linkPopupPos().y)
						}
						onClose={() => setLinkPopupActive(false)}
					/>
				</Portal>
			</Show>
		</Show>
	);
}
