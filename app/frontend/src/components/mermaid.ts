/** Lazy-loaded mermaid renderer. Only imports mermaid when first needed. */

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let lastTheme: "dark" | "light" | null = null;
let renderCounter = 0;

function isDarkMode(): boolean {
	return (
		document.documentElement.getAttribute("data-theme") === "dark" ||
		(document.documentElement.getAttribute("data-theme") !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid");
	}
	return mermaidPromise;
}

/**
 * Scan a container for `<code class="language-mermaid">` blocks
 * and replace them with rendered SVG diagrams.
 */
export async function renderMermaidBlocks(
	container: HTMLElement,
): Promise<void> {
	const codeBlocks = container.querySelectorAll<HTMLElement>(
		"pre > code.language-mermaid",
	);
	if (codeBlocks.length === 0) return;

	const mod = await loadMermaid();
	const currentTheme = isDarkMode() ? "dark" : "light";

	// Re-initialize if theme changed
	if (lastTheme !== currentTheme) {
		lastTheme = currentTheme;
		mod.default.initialize({
			startOnLoad: false,
			theme: currentTheme === "dark" ? "dark" : "neutral",
			securityLevel: "strict",
		});
	}

	for (const code of codeBlocks) {
		const pre = code.parentElement;
		if (!pre) continue;

		const source = code.textContent ?? "";
		if (source.trim() === "") continue;

		const id = `mermaid-${++renderCounter}`;
		try {
			const { svg } = await mod.default.render(id, source.trim());
			const wrapper = document.createElement("div");
			wrapper.className = "mermaid-diagram";
			wrapper.innerHTML = svg;
			pre.replaceWith(wrapper);
		} catch {
			pre.classList.add("mermaid-error");
		}
	}
}
