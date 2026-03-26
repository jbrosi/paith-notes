import { Crepe, CrepeFeature } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createEffect, onCleanup, onMount } from "solid-js";

export type EditorHandle = {
	insertMentionAt: (
		from: number,
		to: number,
		linkText: string,
		href: string,
		embed: boolean,
	) => void;
	replaceQuery: (newQuery: string) => void;
	removeLinkAt: (x: number, y: number) => void;
};

export type MentionStartInfo = {
	rect: { left: number; top: number; bottom: number };
	from: number;
	embed: boolean;
};

export type MilkdownEditorProps = {
	value: string;
	onChange: (value: string) => void;
	readonly?: boolean;
	onNoteLinkClick?: (noteId: string) => void;
	resolveEmbeddedImageSrc?: (noteId: string) => Promise<string | null>;
	uploadEmbeddedImage?: (file: File) => Promise<string | null>;
	resolveNoteTitle?: (id: string) => string | undefined;
	onNoteLinkPopup?: (noteId: string, x: number, y: number) => void;
	onMentionStart?: (info: MentionStartInfo) => void;
	onMentionQuery?: (query: string) => void;
	onMentionCancel?: () => void;
	onEditorReady?: (handle: EditorHandle) => void;
};

// ── Wiki link helpers ─────────────────────────────────────────────────────────
// Stored format:  [[note:uuid]]
// Display format: [Resolved Title](note-ref:uuid)

const WIKI_STORED_RE = /\[\[note:([^\]]+)\]\]/g;
const WIKI_DISPLAY_RE = /\[([^\]]*)\]\(note-ref:([^)]+)\)/g;

function expandWikiLinks(
	content: string,
	resolveTitle: (id: string) => string | undefined,
): string {
	return content.replace(WIKI_STORED_RE, (_, id: string) => {
		const trimmed = id.trim();
		const title = resolveTitle(trimmed) ?? trimmed.slice(0, 8);
		return `[${title}](note-ref:${trimmed})`;
	});
}

function collapseWikiLinks(content: string): string {
	return content.replace(
		WIKI_DISPLAY_RE,
		(_, _title: string, id: string) => `[[note:${id.trim()}]]`,
	);
}

export function MilkdownEditor(props: MilkdownEditorProps) {
	let rootEl!: HTMLDivElement;
	let crepe: Crepe | null = null;
	let lastMarkdownFromEditor = props.value;
	let onRootClick: ((e: MouseEvent) => void) | null = null;
	let onRootChange: ((e: Event) => void) | null = null;
	let embedObserver: MutationObserver | null = null;
	let embedResolveTimer: number | null = null;
	const pendingUploadedFiles: File[] = [];

	// mention tracking
	let pmView: EditorView | null = null;
	let mentionFrom = -1;
	let onViewKeyup: ((e: KeyboardEvent) => void) | null = null;
	let onViewInput: ((e: Event) => void) | null = null;
	let onViewKeydown: ((e: KeyboardEvent) => void) | null = null;

	const destroy = () => {
		if (embedResolveTimer !== null) {
			window.clearTimeout(embedResolveTimer);
			embedResolveTimer = null;
		}
		if (embedObserver) {
			embedObserver.disconnect();
			embedObserver = null;
		}
		if (onRootClick) {
			rootEl.removeEventListener("click", onRootClick);
			onRootClick = null;
		}
		if (onRootChange) {
			rootEl.removeEventListener("change", onRootChange, true);
			onRootChange = null;
		}
		if (pmView) {
			if (onViewKeyup) {
				pmView.dom.removeEventListener("keyup", onViewKeyup);
				onViewKeyup = null;
			}
			if (onViewInput) {
				pmView.dom.removeEventListener("input", onViewInput);
				onViewInput = null;
			}
			if (onViewKeydown) {
				pmView.dom.removeEventListener("keydown", onViewKeydown);
				onViewKeydown = null;
			}
			pmView = null;
		}
		if (mentionFrom >= 0) {
			mentionFrom = -1;
			props.onMentionCancel?.();
		}
		if (crepe) {
			crepe.destroy();
			crepe = null;
		}
	};

	const resolveEmbedsSoon = () => {
		if (!props.resolveEmbeddedImageSrc && !props.uploadEmbeddedImage) return;
		if (embedResolveTimer !== null) return;
		embedResolveTimer = window.setTimeout(() => {
			embedResolveTimer = null;
			void resolveEmbeds();
		}, 0);
	};

	const replaceInMarkdownAndReload = (fromSrc: string, toSrc: string) => {
		const raw = crepe?.getMarkdown() ?? lastMarkdownFromEditor;
		const current = collapseWikiLinks(raw);
		if (!current.includes(fromSrc)) {
			return;
		}
		const next = current.split(fromSrc).join(toSrc);
		if (next === current) {
			return;
		}

		lastMarkdownFromEditor = next;
		props.onChange(next);

		// Ensure the underlying document is updated (DOM mutations alone won't persist).
		destroy();
		void create(next);
	};
	const resolveEmbeds = async () => {
		const uploader = props.uploadEmbeddedImage;
		if (uploader) {
			const images = rootEl.querySelectorAll("img");
			for (const img of images) {
				const src = img.getAttribute("src") ?? "";
				if (!(src.startsWith("blob:") || src.startsWith("data:"))) continue;
				if (img.dataset.noteUploaded === "1") continue;
				if (img.dataset.noteUploading === "1") continue;

				img.dataset.noteUploading = "1";
				try {
					const directFile = pendingUploadedFiles.shift();
					let file: File;
					if (directFile) {
						file = directFile;
					} else {
						const res = await fetch(src);
						if (!res.ok) continue;
						const blob = await res.blob();
						const mime = blob.type || "application/octet-stream";
						const ext = mime.startsWith("image/")
							? mime.slice("image/".length)
							: "bin";
						const rawName = (
							img.getAttribute("alt") ??
							img.getAttribute("title") ??
							""
						).trim();
						const baseName = rawName
							.replace(/\.[a-z0-9]+$/i, "")
							.replace(/[^a-z0-9_-]+/gi, "-")
							.replace(/-+/g, "-")
							.replace(/^-|-$/g, "");
						const finalBase =
							baseName !== "" ? baseName : `embedded-${Date.now()}`;
						file = new File([blob], `${finalBase}.${ext}`, { type: mime });
					}
					const noteId = await uploader(file);
					if (!noteId) continue;

					img.dataset.noteUploaded = "1";
					img.dataset.noteResolved = "0";
					img.removeAttribute("data-note-resolved");
					const noteSrc = `note:${noteId}`;
					img.setAttribute("src", noteSrc);
					replaceInMarkdownAndReload(src, noteSrc);
				} finally {
					img.dataset.noteUploading = "0";
				}
			}
		}

		const resolver = props.resolveEmbeddedImageSrc;
		if (!resolver) return;

		const images = rootEl.querySelectorAll("img");
		for (const img of images) {
			const src = img.getAttribute("src") ?? "";
			if (!src.startsWith("note:")) continue;
			if (img.dataset.noteResolved === "1") continue;
			if (img.dataset.noteResolving === "1") continue;

			const noteId = src.slice("note:".length).trim();
			if (noteId === "") continue;

			img.dataset.noteResolving = "1";
			try {
				const resolved = await resolver(noteId);
				if (resolved) {
					img.dataset.noteOriginalSrc = src;
					img.setAttribute("src", resolved);
					img.dataset.noteResolved = "1";
				}
			} finally {
				img.dataset.noteResolving = "0";
			}
		}
	};

	const create = async (defaultValue: string) => {
		rootEl.innerHTML = "";
		const expanded = props.resolveNoteTitle
			? expandWikiLinks(defaultValue, props.resolveNoteTitle)
			: defaultValue;
		lastMarkdownFromEditor = defaultValue;

		onRootClick = (e: MouseEvent) => {
			const target = e.target;
			if (!(target instanceof Element)) {
				return;
			}
			const anchor = target.closest("a");
			if (!(anchor instanceof HTMLAnchorElement)) {
				return;
			}
			const href = anchor.getAttribute("href") ?? "";
			const isNoteLink =
				href.startsWith("note:") || href.startsWith("note-ref:");
			if (!isNoteLink) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			const noteId = (
				href.startsWith("note-ref:")
					? href.slice("note-ref:".length)
					: href.slice("note:".length)
			).trim();
			if (noteId === "") return;
			if (props.readonly) {
				props.onNoteLinkClick?.(noteId);
			} else {
				props.onNoteLinkPopup?.(noteId, e.clientX, e.clientY);
			}
		};
		rootEl.addEventListener("click", onRootClick);

		onRootChange = (e: Event) => {
			const target = e.target;
			if (!(target instanceof HTMLInputElement)) return;
			if (target.type !== "file") return;
			const files = target.files;
			if (!files || files.length === 0) return;
			for (const f of Array.from(files)) {
				pendingUploadedFiles.push(f);
			}
			resolveEmbedsSoon();
		};
		rootEl.addEventListener("change", onRootChange, true);

		crepe = new Crepe({
			root: rootEl,
			defaultValue: expanded,
			features: { [CrepeFeature.LinkTooltip]: false },
		});

		crepe.on((listener) => {
			listener.markdownUpdated(() => {
				const raw = crepe?.getMarkdown() ?? "";
				const markdown = collapseWikiLinks(raw);
				lastMarkdownFromEditor = markdown;
				props.onChange(markdown);
				resolveEmbedsSoon();
			});
		});

		await crepe.create();
		if (props.readonly) {
			crepe.setReadonly(true);
		}

		// Wire up mention detection via ProseMirror view
		crepe.editor.action((ctx) => {
			const view = ctx.get(editorViewCtx);
			pmView = view;

			onViewKeyup = (e: KeyboardEvent) => {
				if (e.key !== "@") return;
				if (!props.onMentionStart) return;
				const sel = view.state.selection;
				// @ was just inserted; sel.from points just after it
				const atFrom = sel.from - 1;
				if (atFrom < 0) return;
				// Don't trigger in code blocks
				try {
					const $pos = view.state.doc.resolve(atFrom);
					const parentType = $pos.parent.type.name;
					if (parentType === "code_block" || parentType === "fence") return;
					const hasCodeMark = $pos.marks().some((m) => m.type.name === "code");
					if (hasCodeMark) return;
				} catch {
					return;
				}
				// Check for !@ (embed mode) — look at the character before @
				let embed = false;
				let triggerFrom = atFrom;
				if (atFrom > 0) {
					try {
						const charBefore = view.state.doc.textBetween(atFrom - 1, atFrom);
						if (charBefore === "!") {
							embed = true;
							triggerFrom = atFrom - 1;
						}
					} catch {
						// ignore
					}
				}
				const coords = view.coordsAtPos(sel.from);
				mentionFrom = triggerFrom;
				props.onMentionStart({
					rect: {
						left: coords.left,
						top: coords.top,
						bottom: coords.bottom,
					},
					from: mentionFrom,
					embed,
				});
			};

			onViewInput = () => {
				if (mentionFrom < 0) return;
				const state = view.state;
				const cursorPos = state.selection.from;
				if (cursorPos <= mentionFrom) {
					mentionFrom = -1;
					props.onMentionCancel?.();
					return;
				}
				// Verify @ is still at mentionFrom
				try {
					const charAtFrom = state.doc.textBetween(
						mentionFrom,
						mentionFrom + 1,
					);
					if (charAtFrom !== "@") {
						mentionFrom = -1;
						props.onMentionCancel?.();
						return;
					}
					const query = state.doc.textBetween(mentionFrom + 1, cursorPos);
					// Cancel if query contains newline or space that breaks the pattern
					if (query.includes("\n")) {
						mentionFrom = -1;
						props.onMentionCancel?.();
						return;
					}
					props.onMentionQuery?.(query);
				} catch {
					mentionFrom = -1;
					props.onMentionCancel?.();
				}
			};

			onViewKeydown = (e: KeyboardEvent) => {
				if (e.key === "Escape" && mentionFrom >= 0) {
					mentionFrom = -1;
					props.onMentionCancel?.();
				}
			};

			view.dom.addEventListener("keyup", onViewKeyup);
			view.dom.addEventListener("input", onViewInput);
			view.dom.addEventListener("keydown", onViewKeydown);

			// Expose insertion handle to parent
			const handle: EditorHandle = {
				removeLinkAt: (x: number, y: number) => {
					if (!pmView) return;
					const coords = pmView.posAtCoords({ left: x, top: y });
					if (!coords) return;
					const { state, dispatch } = pmView;
					const linkMarkType = state.schema.marks.link;
					if (!linkMarkType) return;
					const $pos = state.doc.resolve(coords.pos);
					const parentStart = $pos.start();
					const parentEnd = $pos.end();
					let linkFrom = coords.pos;
					let linkTo = coords.pos;
					state.doc.nodesBetween(parentStart, parentEnd, (node, nodePos) => {
						if (node.isText && linkMarkType.isInSet(node.marks)) {
							linkFrom = Math.min(linkFrom, nodePos);
							linkTo = Math.max(linkTo, nodePos + node.nodeSize);
						}
					});
					dispatch(state.tr.removeMark(linkFrom, linkTo, linkMarkType));
					pmView.focus();
				},
				replaceQuery: (newQuery: string) => {
					if (!pmView || mentionFrom < 0) return;
					const { state, dispatch } = pmView;
					const cursorPos = state.selection.from;
					const safeFrom = Math.max(
						mentionFrom + 1,
						Math.min(mentionFrom + 1, state.doc.content.size),
					);
					const safeTo = Math.max(
						safeFrom,
						Math.min(cursorPos, state.doc.content.size),
					);
					const tr = state.tr.replaceWith(
						safeFrom,
						safeTo,
						newQuery === "" ? [] : state.schema.text(newQuery),
					);
					dispatch(tr);
				},
				insertMentionAt: (
					from: number,
					to: number,
					linkText: string,
					href: string,
					embed: boolean,
				) => {
					if (!pmView) return;
					const { state, dispatch } = pmView;
					const safeFrom = Math.max(0, Math.min(from, state.doc.content.size));
					const safeTo = Math.max(
						safeFrom,
						Math.min(to, state.doc.content.size),
					);
					// biome-ignore lint/suspicious/noImplicitAnyLet: ProseMirror node union type
					let node;
					if (embed) {
						const imageNodeType = state.schema.nodes.image;
						node = imageNodeType
							? imageNodeType.create({
									src: href,
									alt: linkText,
									title: linkText,
								})
							: state.schema.text(`![${linkText}](${href})`);
					} else {
						const linkMarkType = state.schema.marks.link;
						const linkMark = linkMarkType?.create({ href });
						node = linkMark
							? state.schema.text(linkText, [linkMark])
							: state.schema.text(`[${linkText}](${href})`);
						if (linkMarkType) {
							const tr = state.tr.replaceWith(safeFrom, safeTo, node);
							tr.removeStoredMark(linkMarkType);
							dispatch(tr);
							mentionFrom = -1;
							return;
						}
					}
					const tr = state.tr.replaceWith(safeFrom, safeTo, node);
					dispatch(tr);
					mentionFrom = -1;
				},
			};
			props.onEditorReady?.(handle);
		});

		embedObserver = new MutationObserver(() => {
			resolveEmbedsSoon();
		});
		embedObserver.observe(rootEl, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["src"],
		});

		resolveEmbedsSoon();
	};

	onMount(() => {
		void create(props.value);
	});

	createEffect(() => {
		if (!crepe) {
			return;
		}
		crepe.setReadonly(Boolean(props.readonly));
	});

	createEffect(() => {
		const nextValue = props.value;
		if (!crepe) {
			return;
		}
		if (nextValue.trimEnd() === lastMarkdownFromEditor.trimEnd()) {
			lastMarkdownFromEditor = nextValue;
			return;
		}

		destroy();
		void create(nextValue);
	});

	onCleanup(() => {
		destroy();
	});

	return <div ref={rootEl} />;
}
