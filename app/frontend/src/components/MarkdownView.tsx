import { marked } from "marked";
import { createEffect, createSignal } from "solid-js";
import type { NotePreviewController } from "../pages/nook/NookDefaultLayout";
import styles from "./MarkdownView.module.css";

/** Wiki-link stored format: [[note:uuid]] */
const WIKI_LINK_RE = /\[\[note:([0-9a-f-]+)\]\]/gi;

/** Image embeds referencing notes: ![...](note:uuid) */
const NOTE_IMAGE_RE = /!\[([^\]]*)\]\(note:([0-9a-f-]+)\)/gi;

/** Placeholder prefix used in HTML to identify note links */
const NOTE_HREF_PREFIX = "note-ref:";

/** Configure marked */
marked.use({ async: false, gfm: true });

type Props = {
	/** Raw markdown content (with [[note:id]] wiki-links) */
	content: string;
	/** Called to navigate to a note */
	onNoteLinkClick?: (noteId: string) => void;
	/** Resolve a note ID to its title for display */
	resolveNoteTitle?: (id: string) => string | undefined;
	/** Resolve a note image embed to an inline URL */
	resolveEmbeddedImageSrc?: (noteId: string) => Promise<string | null>;
	/** Note preview controller for hover popover */
	notePreview?: NotePreviewController;
	/** Extra CSS class for the container */
	class?: string;
};

/**
 * Expand [[note:uuid]] to markdown links with resolved titles,
 * keeping note-ref: scheme so we can identify them in the rendered HTML.
 */
function expandWikiLinks(
	content: string,
	resolveTitle?: (id: string) => string | undefined,
): string {
	return content.replace(WIKI_LINK_RE, (_, id: string) => {
		const trimmed = id.trim();
		const title = resolveTitle?.(trimmed) ?? `${trimmed.slice(0, 8)}...`;
		return `[${title}](${NOTE_HREF_PREFIX}${trimmed})`;
	});
}

/**
 * Resolve note:uuid image embeds to actual URLs.
 * Returns the content with resolved image sources.
 */
async function resolveImages(
	content: string,
	resolver: (noteId: string) => Promise<string | null>,
): Promise<string> {
	const matches = [...content.matchAll(NOTE_IMAGE_RE)];
	if (matches.length === 0) return content;

	const resolved = await Promise.all(
		matches.map(async (m) => {
			const url = await resolver(m[2]);
			return { match: m[0], alt: m[1], url };
		}),
	);

	let result = content;
	for (const r of resolved) {
		if (r.url) {
			result = result.replace(r.match, `![${r.alt}](${r.url})`);
		}
	}
	return result;
}

/** Quick check if content has mermaid fenced blocks (avoids lazy import when not needed) */
function hasMermaid(content: string): boolean {
	return /```mermaid\b/i.test(content);
}

export function MarkdownView(props: Props) {
	const [html, setHtml] = createSignal("");
	let containerEl: HTMLDivElement | undefined;

	createEffect(() => {
		const raw = props.content;
		const expanded = expandWikiLinks(raw, props.resolveNoteTitle);

		if (props.resolveEmbeddedImageSrc) {
			void resolveImages(expanded, props.resolveEmbeddedImageSrc).then(
				(resolved) => {
					setHtml(marked.parse(resolved) as string);
				},
			);
		} else {
			setHtml(marked.parse(expanded) as string);
		}
	});

	// After HTML is rendered, highlight code blocks and render mermaid diagrams
	createEffect(() => {
		const rendered = html();
		if (!containerEl || !rendered) return;

		// Defer to next microtask so innerHTML is applied first
		queueMicrotask(() => {
			if (!containerEl) return;
			const el = containerEl as HTMLElement;

			// Syntax highlighting (lazy)
			void import("./highlight").then(({ highlightCodeBlocks }) =>
				highlightCodeBlocks(el),
			);

			// Mermaid diagrams (lazy, only if content has mermaid blocks)
			if (hasMermaid(props.content)) {
				void import("./mermaid").then(({ renderMermaidBlocks }) =>
					renderMermaidBlocks(el),
				);
			}
		});
	});

	const handleClick = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest("a");
		if (!target) return;
		const href = target.getAttribute("href") ?? "";
		if (href.startsWith(NOTE_HREF_PREFIX)) {
			e.preventDefault();
			const noteId = href.slice(NOTE_HREF_PREFIX.length);
			props.notePreview?.dismiss();
			props.onNoteLinkClick?.(noteId);
		}
	};

	const handleMouseOver = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest("a");
		if (!target) return;
		const href = target.getAttribute("href") ?? "";
		if (href.startsWith(NOTE_HREF_PREFIX) && props.notePreview) {
			const noteId = href.slice(NOTE_HREF_PREFIX.length);
			props.notePreview.show(noteId, e.clientX, e.clientY, {
				onOpen: props.onNoteLinkClick
					? (id) => props.onNoteLinkClick?.(id)
					: undefined,
			});
		}
	};

	const handleMouseOut = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest("a");
		if (!target) return;
		const href = target.getAttribute("href") ?? "";
		if (href.startsWith(NOTE_HREF_PREFIX) && props.notePreview) {
			props.notePreview.hide();
		}
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: note links have href fallback
		// biome-ignore lint/a11y/useKeyWithMouseEvents: hover preview is mouse-only
		// biome-ignore lint/a11y/noStaticElementInteractions: event delegation on rendered HTML
		<div
			ref={containerEl}
			class={`${styles.markdown} ${props.class ?? ""}`}
			innerHTML={html()}
			onClick={handleClick}
			onMouseOver={handleMouseOver}
			onMouseOut={handleMouseOut}
		/>
	);
}
