import * as d3 from "d3";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./ImageLightbox.module.css";

/**
 * Fullscreen image viewer with d3-zoom pan + wheel/pinch zoom. State is
 * ephemeral — closing always resets zoom, so the inline embed the user
 * came from is never touched.
 *
 * Global usage:
 *   • Mount `<ImageLightbox />` once at the app root (already handled in
 *     App.tsx).
 *   • Anywhere in the app, call `openImageLightbox({src, alt?})` to open.
 *
 * Kept in a module-level signal because the trigger sites (rendered
 * markdown `<img>` tags, embedded chat images) don't share a component
 * ancestor — a context provider would be overkill.
 */

type LightboxTarget = { src: string; alt?: string } | null;

const [target, setTarget] = createSignal<LightboxTarget>(null);

/** Open the fullscreen viewer on the given image. */
export function openImageLightbox(t: { src: string; alt?: string }): void {
	setTarget(t);
}

export function ImageLightbox() {
	let containerEl: HTMLDivElement | undefined;
	let imgEl: HTMLImageElement | undefined;
	// Keep a handle to the zoom behavior so we can reset on close.
	let zoomBehavior: d3.ZoomBehavior<HTMLDivElement, unknown> | undefined;

	const close = () => setTarget(null);

	// Keyboard: ESC closes, R resets zoom, +/- adjust. Global listener so
	// focus doesn't need to be inside the modal for ESC to work.
	const onKeyDown = (e: KeyboardEvent) => {
		if (!target()) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "r" || e.key === "R") {
			resetZoom();
		} else if (e.key === "+" || e.key === "=") {
			zoomBy(1.4);
		} else if (e.key === "-" || e.key === "_") {
			zoomBy(1 / 1.4);
		}
	};

	onMount(() => {
		document.addEventListener("keydown", onKeyDown);
	});
	onCleanup(() => {
		document.removeEventListener("keydown", onKeyDown);
	});

	const resetZoom = () => {
		if (!containerEl || !zoomBehavior) return;
		d3.select(containerEl)
			.transition()
			.duration(180)
			.call(zoomBehavior.transform, d3.zoomIdentity);
	};

	const zoomBy = (factor: number) => {
		if (!containerEl || !zoomBehavior) return;
		d3.select(containerEl)
			.transition()
			.duration(120)
			.call(zoomBehavior.scaleBy, factor);
	};

	// Wire d3-zoom once the image has mounted and loaded. Attaching before
	// image dimensions are known would give the transform origin bad
	// bounds; waiting for the load event keeps the initial state clean.
	const setupZoom = () => {
		if (!containerEl) return;
		// The .viewport div is the element that carries the transform;
		// the container captures wheel/drag events across the whole
		// viewport. Same pattern the graph renderer uses.
		const viewport = containerEl.querySelector<HTMLDivElement>(
			`.${styles.viewport}`,
		);
		if (!viewport) return;

		// Clamp scale between 0.25× (fit-to-view still smaller) and 10×
		// (extreme zoom for detail). Larger than 10× hits pixel grain
		// on typical inputs — not useful.
		zoomBehavior = d3
			.zoom<HTMLDivElement, unknown>()
			.scaleExtent([0.25, 10])
			// filter: allow left-click drag pan and wheel/pinch zoom;
			// reject right-click so the browser's context menu still works.
			.filter((event: Event) => {
				if (event.type === "wheel") return true;
				const me = event as MouseEvent;
				return me.button === 0;
			})
			.on("zoom", (event) => {
				// d3.transform stringifies to "translate(X,Y) scale(K)",
				// which is a valid CSS transform. transform-origin is
				// (0,0) on .viewport, so event coords map directly.
				viewport.style.transform = String(event.transform);
			});
		d3.select(containerEl).call(zoomBehavior);
		// Double-click to reset — d3's default double-click behavior is
		// to zoom in, which fights the "reset" idiom users expect.
		d3.select(containerEl).on("dblclick.zoom", null);
		containerEl.addEventListener("dblclick", resetZoom);
	};

	return (
		<Show when={target()}>
			{(t) => (
				<Portal mount={document.body}>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled globally at document level */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop-click closes; keyboard already covered by global ESC listener */}
					<div
						class={styles.backdrop}
						onClick={(e) => {
							// Only close on backdrop click, not on image drag/click.
							if (e.target === e.currentTarget) close();
						}}
					>
						<div class={styles.container} ref={containerEl}>
							<div class={styles.viewport}>
								<img
									ref={(el) => {
										imgEl = el;
										// If already loaded from cache, `load` never fires.
										if (el.complete && el.naturalWidth > 0) setupZoom();
										else el.addEventListener("load", setupZoom, { once: true });
									}}
									src={t().src}
									alt={t().alt ?? ""}
									class={styles.image}
									draggable={false}
								/>
							</div>
						</div>

						<div class={styles.toolbar}>
							<button
								type="button"
								class={styles.toolbarBtn}
								onClick={(e) => {
									e.stopPropagation();
									zoomBy(1.4);
								}}
								title="Zoom in (+)"
								aria-label="Zoom in"
							>
								+
							</button>
							<button
								type="button"
								class={styles.toolbarBtn}
								onClick={(e) => {
									e.stopPropagation();
									zoomBy(1 / 1.4);
								}}
								title="Zoom out (−)"
								aria-label="Zoom out"
							>
								−
							</button>
							<button
								type="button"
								class={styles.toolbarBtn}
								onClick={(e) => {
									e.stopPropagation();
									resetZoom();
								}}
								title="Reset (R or double-click)"
								aria-label="Reset zoom"
							>
								↺
							</button>
							<button
								type="button"
								class={`${styles.toolbarBtn} ${styles.toolbarClose}`}
								onClick={(e) => {
									e.stopPropagation();
									close();
								}}
								title="Close (Esc)"
								aria-label="Close"
							>
								✕
							</button>
						</div>
					</div>
				</Portal>
			)}
		</Show>
	);
}
