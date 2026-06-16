import { marked } from "marked";
import { createEffect, createSignal, For, Show } from "solid-js";
import {
	type NotePreviewController,
	useNook,
	useNotePreview,
	useNoteResolver,
} from "../pages/nook/NookContext";
import { NookEmbeddedGraph } from "../pages/nook/NookEmbeddedGraph";
import { type GraphViewProperties, parseGraphUri } from "../pages/nook/types";
import styles from "./MarkdownView.module.css";

/** Wiki-link: [[note:uuid]] or [[note:nookId/noteId]] */
const WIKI_LINK_RE = /\[\[note:(?:([0-9a-f-]+)\/)?([0-9a-f-]+)\]\]/gi;

/** Graph wiki-link: [[graph:?root=...&depth=...&...]] — rendered as a link to
 * the real fullscreen URL (mirrors [[note:uuid]] but no embed). */
const WIKI_GRAPH_RE = /\[\[graph:([^\]]+)\]\]/gi;

/** Image embeds: ![...](note:uuid) or ![...](note:nookId/noteId) */
const NOTE_IMAGE_RE = /!\[([^\]]*)\]\(note:(?:[0-9a-f-]+\/)?([0-9a-f-]+)\)/gi;

/** Graph image embeds: ![label](graph:?root=...&...) OR
 * ![label](/nooks/<n>/notes/<root>?fullscreen=1&...). Both forms parse via
 * parseGraphUri — we split the markdown around these so each becomes an
 * interactive NookEmbeddedGraph block in the rendered tree. */
const GRAPH_EMBED_RE =
	/!\[([^\]]*)\]\((graph:[^)\s]+|\/nooks\/[^?)\s]+\?[^)\s]*fullscreen[^)\s]*)\)/gi;

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

/** Expand [[graph:params]] to a markdown link pointing at the fullscreen URL.
 * The link is Ctrl-clickable like any markdown link. */
function expandGraphWikiLinks(content: string, currentNookId: string): string {
	return content.replace(WIKI_GRAPH_RE, (_, paramsRaw: string) => {
		const uri = `graph:${paramsRaw}`;
		const parsed = parseGraphUri(uri);
		const config = parsed?.config;
		if (!config?.rootNoteId || !currentNookId) {
			// Fall back to a literal link so the user still sees something
			return `[graph view](${uri})`;
		}
		const params = new URLSearchParams();
		for (const [k, v] of new URLSearchParams(paramsRaw)) {
			if (k !== "root") params.set(k, v);
		}
		params.set("fullscreen", "1");
		const href = `/nooks/${encodeURIComponent(currentNookId)}/notes/${encodeURIComponent(config.rootNoteId)}?${params.toString()}`;
		return `[graph view](${href})`;
	});
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

/** Segment of rendered content: a plain markdown text run OR an inline
 * graph-view block that mounts NookEmbeddedGraph. We split on graph embeds
 * so each becomes a real Solid component (which the markdown HTML pipeline
 * can't produce by itself). */
type Segment =
	| { kind: "md"; text: string }
	| { kind: "graph"; config: GraphViewProperties };

function splitGraphSegments(content: string): Segment[] {
	const out: Segment[] = [];
	let cursor = 0;
	for (const m of content.matchAll(GRAPH_EMBED_RE)) {
		const start = m.index ?? 0;
		if (start > cursor) {
			out.push({ kind: "md", text: content.slice(cursor, start) });
		}
		const parsed = parseGraphUri(m[2]);
		if (parsed?.config?.rootNoteId) {
			out.push({
				kind: "graph",
				config: {
					rootNoteId: parsed.config.rootNoteId,
					...parsed.config,
				} as GraphViewProperties,
			});
		} else {
			// Unparseable — leave the raw image tag in place
			out.push({ kind: "md", text: m[0] });
		}
		cursor = start + m[0].length;
	}
	if (cursor < content.length) {
		out.push({ kind: "md", text: content.slice(cursor) });
	}
	return out.length > 0 ? out : [{ kind: "md", text: content }];
}

export function MarkdownView(props: Props) {
	const [segments, setSegments] = createSignal<Segment[]>([]);
	// Per-segment rendered HTML (parallel array to segments, only populated
	// for kind === "md" entries).
	const [renderedHtml, setRenderedHtml] = createSignal<string[]>([]);
	const resolver = useNoteResolver();
	const ctxPreview = useNotePreview();
	const nookCtx = (() => {
		try {
			return useNook();
		} catch {
			return null;
		}
	})();
	const preview = () => props.notePreview ?? ctxPreview;

	const renderMd = (text: string, currentNook: string): string => {
		const resolveTitle = props.resolveNoteTitle
			? (id: string) => props.resolveNoteTitle?.(id)
			: (id: string, nookId?: string) =>
					resolver.resolveTitle(id, nookId || currentNook);
		const withWiki = expandWikiLinks(
			text,
			resolveTitle,
			resolver.resolveNookName,
			currentNook,
		);
		const withGraphLinks = expandGraphWikiLinks(withWiki, currentNook);
		return marked.parse(withGraphLinks) as string;
	};

	createEffect(() => {
		const raw = props.content;
		const currentNook = resolver.currentNookId();
		const segs = splitGraphSegments(raw);
		setSegments(segs);

		// Trigger async fetch for any unresolved note titles
		if (!props.resolveNoteTitle) {
			const refs = extractNoteRefs(raw);
			const missing = refs.filter(
				(r) => !resolver.resolveTitle(r.noteId, r.nookId || currentNook),
			);
			if (missing.length > 0) resolver.fetchMissing(missing);
		}

		const renderSegments = (
			mdResolver: (s: string) => string | Promise<string>,
		) =>
			Promise.all(
				segs.map(async (s) =>
					s.kind === "md" ? await mdResolver(s.text) : "",
				),
			);

		const imageResolver = props.resolveEmbeddedImageSrc;
		if (imageResolver) {
			void renderSegments(async (text) => {
				const resolved = await resolveImages(text, imageResolver);
				return renderMd(resolved, currentNook);
			}).then((arr) => setRenderedHtml(arr));
		} else {
			void renderSegments((text) => renderMd(text, currentNook)).then((arr) =>
				setRenderedHtml(arr),
			);
		}
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

	// After HTML segments are mounted, highlight code blocks + mermaid.
	// Mounts an effect on each segment by using a ref callback.
	const mountedRefs = new Set<HTMLElement>();
	const setupSegmentEl = (el: HTMLDivElement | undefined) => {
		if (!el || mountedRefs.has(el)) return;
		mountedRefs.add(el);
		queueMicrotask(() => {
			void import("./highlight").then(({ highlightCodeBlocks }) =>
				highlightCodeBlocks(el),
			);
			if (hasMermaid(el.innerHTML)) {
				void import("./mermaid").then(({ renderMermaidBlocks }) =>
					renderMermaidBlocks(el),
				);
			}
		});
	};

	const store = () => nookCtx?.store() ?? null;

	return (
		// biome-ignore lint/a11y/useKeyWithMouseEvents: hover preview is mouse-only
		// biome-ignore lint/a11y/noStaticElementInteractions: event delegation on rendered HTML
		<div
			class={`${styles.markdown} ${props.class ?? ""}`}
			onMouseOver={handleMouseOver}
			onMouseOut={handleMouseOut}
		>
			<For each={segments()}>
				{(seg, i) =>
					seg.kind === "md" ? (
						<div ref={setupSegmentEl} innerHTML={renderedHtml()[i()] ?? ""} />
					) : (
						<Show
							when={store()}
							fallback={
								<a
									href={`graph:?root=${seg.config.rootNoteId}`}
									class={styles.graphEmbedLink}
								>
									Graph view
								</a>
							}
						>
							{(s) => (
								<NookEmbeddedGraph
									store={s()}
									graphProps={seg.config}
									onConfigChange={() => {
										/* read-only: tweaks stay local */
									}}
								/>
							)}
						</Show>
					)
				}
			</For>
		</div>
	);
}
