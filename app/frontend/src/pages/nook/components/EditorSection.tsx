import { createSignal, For, Show } from "solid-js";
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
				<Show when={props.store.noteHeadings().length > 0}>
					<TableOfContents headings={props.store.noteHeadings()} />
				</Show>
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

function TableOfContents(props: {
	headings: Array<{ level: number; text: string; position: number }>;
}) {
	const [open, setOpen] = createSignal(false);
	const minLevel = () =>
		Math.min(...props.headings.map((h) => h.level));

	const scrollToHeading = (text: string) => {
		// Find the rendered heading element by matching text content
		const container = document.querySelector("[data-note-content]") ?? document.body;
		const headingEls = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
		for (const el of headingEls) {
			if (el.textContent?.trim() === text) {
				el.scrollIntoView({ behavior: "smooth", block: "start" });
				return;
			}
		}
	};

	return (
		<div
			style={{
				"margin-bottom": "12px",
				border: "1px solid var(--color-border-light, #e5e7eb)",
				"border-radius": "6px",
				"font-size": "0.8rem",
				overflow: "hidden",
			}}
		>
			<button
				type="button"
				onClick={() => setOpen(!open())}
				style={{
					width: "100%",
					padding: "6px 10px",
					border: "none",
					background: "var(--color-bg-secondary, #f9fafb)",
					cursor: "pointer",
					display: "flex",
					"align-items": "center",
					gap: "4px",
					"font-size": "0.7rem",
					"font-weight": "600",
					color: "var(--color-text-secondary, #6b7280)",
				}}
			>
				<span style={{ "font-size": "0.6rem" }}>{open() ? "▼" : "▶"}</span>
				Table of contents
				<span
					style={{
						"margin-left": "auto",
						"font-weight": "400",
						color: "var(--color-text-muted)",
					}}
				>
					{props.headings.length}
				</span>
			</button>
			<Show when={open()}>
				<div style={{ padding: "4px 0" }}>
					<For each={props.headings}>
						{(h) => (
							<button
								type="button"
								onClick={() => scrollToHeading(h.text)}
								style={{
									display: "block",
									width: "100%",
									padding: "3px 10px",
									"padding-left": `${10 + (h.level - minLevel()) * 14}px`,
									border: "none",
									background: "none",
									"text-align": "left",
									cursor: "pointer",
									"font-size": "0.75rem",
									color: "var(--color-text-secondary)",
									"white-space": "nowrap",
									overflow: "hidden",
									"text-overflow": "ellipsis",
								}}
								title={h.text}
							>
								{h.text}
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
