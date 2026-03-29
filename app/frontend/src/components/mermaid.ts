/** Lazy-loaded mermaid renderer. Only imports mermaid when first needed. */

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let initialized = false;
let renderCounter = 0;

function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => {
			if (!initialized) {
				mod.default.initialize({
					startOnLoad: false,
					theme: "neutral",
					securityLevel: "strict",
				});
				initialized = true;
			}
			return mod;
		});
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
