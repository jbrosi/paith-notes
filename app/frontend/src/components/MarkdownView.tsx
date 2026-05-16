import { marked } from "marked";
import { createEffect, createSignal } from "solid-js";
import {
	type NotePreviewController,
	useNotePreview,
	useNoteResolver,
} from "../pages/nook/NookContext";
import styles from "./MarkdownView.module.css";

/** Wiki-link: [[note:uuid]] or [[note:nookId/noteId]] */
const WIKI_LINK_RE = /\[\[note:(?:([0-9a-f-]+)\/)?([0-9a-f-]+)\]\]/gi;

/** Image embeds: ![...](note:uuid) or ![...](note:nookId/noteId) */
const NOTE_IMAGE_RE = /!\[([^\]]*)\]\(note:(?:[0-9a-f-]+\/)?([0-9a-f-]+)\)/gi;

/** Configure marked */
marked.use({ async: false, gfm: true });

type Props = {
	/** Raw markdown content (with [[note:id]] wiki-links) */
	content: string;
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
 * Expand [[note:uuid]] or [[note:nookId/noteId]] to real URL links.
 */
function expandWikiLinks(
	content: string,
	resolveTitle?: (id: string, nookId?: string) => string | undefined,
	resolveNookName?: (nookId: string) => string | undefined,
	currentNookId?: string,
): string {
	return content.replace(
		WIKI_LINK_RE,
		(_, nookId: string | undefined, noteId: string) => {
			const trimmedNote = noteId.trim();
			const trimmedNook = nookId?.trim() ?? "";
			const title =
				resolveTitle?.(trimmedNote, trimmedNook || currentNookId) ??
				`${trimmedNote.slice(0, 8)}...`;
			const isCrossNook = trimmedNook !== "" && trimmedNook !== currentNookId;
			const nookLabel = isCrossNook
				? (resolveNookName?.(trimmedNook) ?? "")
				: "";
			const display = nookLabel ? `${title} · ${nookLabel}` : title;
			const nook = trimmedNook || currentNookId || "_";
			const href = `/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(trimmedNote)}`;
			return `[${display}](${href})`;
		},
	);
}

/**
 * Resolve note:uuid image embeds to actual URLs.
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

/** Quick check if content has mermaid fenced blocks */
function hasMermaid(content: string): boolean {
	return /```mermaid\b/i.test(content);
}

/** Extract all {nookId?, noteId} from wiki-link syntax */
function extractNoteRefs(
	content: string,
): Array<{ nookId: string; noteId: string }> {
	const refs: Array<{ nookId: string; noteId: string }> = [];
	for (const m of content.matchAll(WIKI_LINK_RE)) {
		const noteId = m[2]?.trim() ?? "";
		const nookId = m[1]?.trim() ?? "";
		if (noteId) refs.push({ nookId, noteId });
	}
	return refs;
}

/** Parse /nooks/{nookId}/notes/{noteId} from a link href */
function parseNoteRef(href: string): { nookId: string; noteId: string } | null {
	const m = href.match(/^\/nooks\/([^/]+)\/notes\/([^/]+)$/);
	if (!m) return null;
	return {
		nookId: decodeURIComponent(m[1]),
		noteId: decodeURIComponent(m[2]),
	};
}

export function MarkdownView(props: Props) {
	const [html, setHtml] = createSignal("");
	let containerEl: HTMLDivElement | undefined;
	const resolver = useNoteResolver();
	const ctxPreview = useNotePreview();
	const preview = () => props.notePreview ?? ctxPreview;

	createEffect(() => {
		const raw = props.content;
		const currentNook = resolver.currentNookId();
		const resolveTitle = props.resolveNoteTitle
			? (id: string) => props.resolveNoteTitle?.(id)
			: (id: string, nookId?: string) =>
					resolver.resolveTitle(id, nookId || currentNook);
		const expanded = expandWikiLinks(
			raw,
			resolveTitle,
			resolver.resolveNookName,
			currentNook,
		);

		// Trigger async fetch for any unresolved note titles
		if (!props.resolveNoteTitle) {
			const refs = extractNoteRefs(raw);
			const missing = refs.filter(
				(r) => !resolver.resolveTitle(r.noteId, r.nookId || currentNook),
			);
			if (missing.length > 0) resolver.fetchMissing(missing);
		}

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

	// After HTML is rendered, highlight code blocks and render mermaid
	createEffect(() => {
		const rendered = html();
		if (!containerEl || !rendered) return;

		queueMicrotask(() => {
			if (!containerEl) return;
			const el = containerEl as HTMLElement;

			void import("./highlight").then(({ highlightCodeBlocks }) =>
				highlightCodeBlocks(el),
			);

			if (hasMermaid(props.content)) {
				void import("./mermaid").then(({ renderMermaidBlocks }) =>
					renderMermaidBlocks(el),
				);
			}
		});
	});

	// Hover preview for note links
	let lastHoveredLink: Element | null = null;
	const handleMouseOver = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest("a");
		const p = preview();
		if (!target || !p) return;
		const parsed = parseNoteRef(target.getAttribute("href") ?? "");
		if (!parsed) return;
		if (target === lastHoveredLink) return; // same link, don't reposition
		lastHoveredLink = target;
		const rect = target.getBoundingClientRect();
		p.show(parsed.noteId, rect.left, rect.bottom, {
			nookId: parsed.nookId || undefined,
		});
	};

	const handleMouseOut = (e: MouseEvent) => {
		const target = (e.target as HTMLElement).closest("a");
		const p = preview();
		if (!target || !p) return;
		// Only hide if actually leaving the link (not entering a child)
		const related = e.relatedTarget as HTMLElement | null;
		if (related && target.contains(related)) return;
		lastHoveredLink = null;
		if (parseNoteRef(target.getAttribute("href") ?? "")) {
			p.hide();
		}
	};

	return (
		// biome-ignore lint/a11y/useKeyWithMouseEvents: hover preview is mouse-only
		// biome-ignore lint/a11y/noStaticElementInteractions: event delegation on rendered HTML
		<div
			ref={containerEl}
			class={`${styles.markdown} ${props.class ?? ""}`}
			innerHTML={html()}
			onMouseOver={handleMouseOver}
			onMouseOut={handleMouseOut}
		/>
	);
}
