/** Lazy-loaded syntax highlighter. Only imports highlight.js when first needed. */

let hljsPromise: Promise<typeof import("highlight.js")> | null = null;
let themeLoaded: "light" | "dark" | null = null;

function isDarkMode(): boolean {
	return (
		document.documentElement.getAttribute("data-theme") === "dark" ||
		(document.documentElement.getAttribute("data-theme") !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

function loadTheme() {
	const mode = isDarkMode() ? "dark" : "light";
	if (themeLoaded === mode) return;
	themeLoaded = mode;
	if (mode === "dark") {
		import("highlight.js/styles/github-dark.min.css");
	} else {
		import("highlight.js/styles/github.min.css");
	}
}

function loadHljs() {
	if (!hljsPromise) {
		// highlight.js/lib/common includes ~40 popular languages
		hljsPromise = import("highlight.js/lib/common");
	}
	loadTheme();
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

	// Only load if there are non-mermaid code blocks
	const toHighlight = Array.from(codeBlocks).filter(
		(el) => !el.classList.contains("language-mermaid"),
	);
	if (toHighlight.length === 0) return;

	const mod = await loadHljs();
	const hljs = mod.default;

	for (const code of toHighlight) {
		// Skip if already highlighted
		if (code.dataset.highlighted === "yes") continue;
		hljs.highlightElement(code);
	}
}
