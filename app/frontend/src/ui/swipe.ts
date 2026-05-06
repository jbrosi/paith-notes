/**
 * Lightweight horizontal swipe detector — replaces @use-gesture/vanilla.
 * Tracks touch start/end to detect left/right swipes that exceed
 * the configured distance and velocity thresholds.
 */

export type SwipeHandler = (direction: -1 | 1, event: TouchEvent) => void;

export type SwipeOptions = {
	/** Minimum horizontal distance in px (default: 50) */
	distance?: number;
	/** Minimum velocity in px/ms (default: 0.3) */
	velocity?: number;
	/** Ignore swipes starting on these selectors */
	ignore?: string;
};

export function attachSwipe(
	el: HTMLElement,
	onSwipe: SwipeHandler,
	opts: SwipeOptions = {},
): () => void {
	const minDistance = opts.distance ?? 50;
	const minVelocity = opts.velocity ?? 0.3;
	const ignoreSelector =
		opts.ignore ??
		"input, textarea, [contenteditable], .milkdown, .ProseMirror";

	let startX = 0;
	let startTime = 0;
	let tracking = false;

	const onTouchStart = (e: TouchEvent) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;

		// Allow swipe on readonly textareas
		if (target instanceof HTMLTextAreaElement && target.readOnly) {
			// ok
		} else if (target.closest(ignoreSelector)) {
			return;
		}

		const touch = e.touches[0];
		if (!touch) return;
		startX = touch.clientX;
		startTime = Date.now();
		tracking = true;
	};

	const onTouchEnd = (e: TouchEvent) => {
		if (!tracking) return;
		tracking = false;

		const touch = e.changedTouches[0];
		if (!touch) return;

		const dx = touch.clientX - startX;
		const dt = Date.now() - startTime;
		if (dt === 0) return;

		const absDx = Math.abs(dx);
		const velocity = absDx / dt;

		if (absDx >= minDistance && velocity >= minVelocity) {
			onSwipe(dx > 0 ? 1 : -1, e);
		}
	};

	el.addEventListener("touchstart", onTouchStart, { passive: true });
	el.addEventListener("touchend", onTouchEnd, { passive: true });

	return () => {
		el.removeEventListener("touchstart", onTouchStart);
		el.removeEventListener("touchend", onTouchEnd);
	};
}
