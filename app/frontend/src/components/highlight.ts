/** Lazy-loaded syntax highlighter. Only imports highlight.js when first needed. */

let hljsPromise: Promise<typeof import("highlight.js")> | null = null;

function loadHljs() {
	if (!hljsPromise) {
		hljsPromise = import("highlight.js/lib/common");
		// Load both themes — CSS handles which one applies via prefers-color-scheme / data-theme
		import("./highlight-themes.css");
	}
	return hljsPromise;
}

/**
 * Scan a container for `<pre><code class="language-*">` blocks
 * and apply syntax highlighting. Skips mermaid blocks.
 */
export async function highlightCodeBlocks(
	container: HTMLElement,
): Promise<void> {
	const codeBlocks = container.querySelectorAll<HTMLElement>("pre > code");
	if (codeBlocks.length === 0) return;

	const toHighlight = Array.from(codeBlocks).filter(
		(el) => !el.classList.contains("language-mermaid"),
	);
	if (toHighlight.length === 0) return;

	const mod = await loadHljs();
	const hljs = mod.default;

	for (const code of toHighlight) {
		if (code.dataset.highlighted === "yes") continue;
		hljs.highlightElement(code);
	}
}
