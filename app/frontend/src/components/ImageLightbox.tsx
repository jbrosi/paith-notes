import * as d3 from "d3";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
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
	// Direct element refs — no querySelector-by-CSS-module-class dance,
	// which was silently returning null in some rebuild scenarios and
	// caused the "sometimes doesn't open / zoom doesn't work" symptom.
	let containerEl: HTMLDivElement | undefined;
	let viewportEl: HTMLDivElement | undefined;
	let imgEl: HTMLImageElement | undefined;
	// The zoom behavior for the currently-open target. Cleared on close so
	// a reopen creates a fresh one on the new elements.
	let zoomBehavior: d3.ZoomBehavior<HTMLDivElement, unknown> | undefined;

	const close = () => setTarget(null);

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

	// Keyboard: ESC closes, R resets, +/- adjust. Global listener so
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

	const setupZoom = () => {
		if (!containerEl || !viewportEl) return;

		// Reset any previous state from the last open so a reopen starts
		// clean. Without this the container keeps handlers from the prior
		// zoom instance and the viewport keeps its old transform.
		d3.select(containerEl).on(".zoom", null);
		viewportEl.style.transform = "";

		// Clamp scale between 0.25× and 10×. Larger than 10× hits pixel
		// grain on typical inputs — not useful.
		zoomBehavior = d3
			.zoom<HTMLDivElement, unknown>()
			.scaleExtent([0.25, 10])
			// Permissive filter: allow left-click drag, wheel + pinch,
			// AND touch pans. d3-zoom's default filter rejects right-
			// click (button !== 0) — we honour that by allowing anything
			// that's not an explicit right/middle mouse button. Touch
			// events have no `button` property, so this falls through
			// via the `!== 2 && !== 1` check.
			.filter((event: Event) => {
				if (event.type === "wheel") return !event.defaultPrevented;
				const me = event as MouseEvent;
				return !event.defaultPrevented && me.button !== 1 && me.button !== 2;
			})
			.on("zoom", (event) => {
				if (!viewportEl) return;
				// d3.transform stringifies to "translate(X,Y) scale(K)",
				// a valid CSS transform. transform-origin is (0,0) on
				// .viewport so event coords map 1:1.
				viewportEl.style.transform = String(event.transform);
			});

		d3.select(containerEl).call(zoomBehavior);
		// d3's default double-click zooms in, which fights the "reset"
		// idiom users expect from a lightbox. Replace with our own.
		d3.select(containerEl).on("dblclick.zoom", null);
		d3.select(containerEl).on("dblclick.reset", () => resetZoom());
	};

	// Re-run setup whenever a new target opens AND the DOM is committed.
	// The previous implementation kicked off setup from the img's `load`
	// event, which worked for uncached images but for cached ones the
	// ref callback fired before Solid had actually attached the elements
	// to the document — so `containerEl` was sometimes null or lacked
	// dimensions, and d3.zoom silently no-op'd on those events. Two rAFs
	// guarantee both refs are populated AND the browser has laid the
	// tree out (so getBoundingClientRect returns real values).
	createEffect(() => {
		const t = target();
		if (!t) {
			// Closed — release the zoom instance so the next open can
			// start fresh on new elements.
			zoomBehavior = undefined;
			return;
		}
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (target()) setupZoom();
			});
		});
	});

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
							<div class={styles.viewport} ref={viewportEl}>
								<img
									ref={imgEl}
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
