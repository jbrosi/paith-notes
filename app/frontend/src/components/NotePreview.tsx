import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { apiFetch } from "../auth/keycloak";
import styles from "./NotePreview.module.css";

type NotePreviewData = {
	id: string;
	title: string;
	content: string;
	type: string;
};

export type PreviewAction = {
	label: string;
	onClick: () => void;
	danger?: boolean;
};

type ShowOptions = {
	/** Custom actions rendered below the content (e.g. "Remove link") */
	actions?: PreviewAction[];
	/** Called when the header is clicked. Omit to disable header click. */
	onOpen?: (noteId: string) => void;
	/** Show immediately (no hover delay) — use for click-triggered popups */
	immediate?: boolean;
};

type PreviewState = {
	noteId: string;
	x: number;
	y: number;
	data: NotePreviewData | null;
	loading: boolean;
	fading: boolean;
	actions: PreviewAction[];
	onOpen?: (noteId: string) => void;
};

const SHOW_DELAY = 350;
const HIDE_DELAY = 250;
const FADE_DURATION = 150;
const cache = new Map<string, NotePreviewData>();

/** Strip markdown formatting for a plain-text snippet */
function stripMarkdown(md: string): string {
	return md
		.replace(/!\[.*?\]\(.*?\)/g, "") // images
		.replace(/\[([^\]]*)\]\(.*?\)/g, "$1") // links
		.replace(/\[\[note:[^\]]*\]\]/g, "") // wiki links
		.replace(/#{1,6}\s+/g, "") // headings
		.replace(/[*_~`]+/g, "") // emphasis, code
		.replace(/^[-*+]\s+/gm, "") // list items
		.replace(/^\d+\.\s+/gm, "") // ordered list
		.replace(/^>\s+/gm, "") // blockquotes
		.replace(/\n{3,}/g, "\n\n") // excess newlines
		.trim();
}

/**
 * Creates a note preview controller scoped to a nook.
 * Returns `show(noteId, x, y, opts?)` / `hide()` / the `PreviewPopover` component.
 */
export function createNotePreview(nookId: () => string) {
	const [state, setState] = createSignal<PreviewState | null>(null);
	let showTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let fadeTimer: ReturnType<typeof setTimeout> | null = null;
	let abortCtrl: AbortController | null = null;

	const clearShowTimer = () => {
		if (showTimer) {
			clearTimeout(showTimer);
			showTimer = null;
		}
	};

	const clearHideTimer = () => {
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
	};

	const clearFadeTimer = () => {
		if (fadeTimer) {
			clearTimeout(fadeTimer);
			fadeTimer = null;
		}
	};

	/** Immediately remove the popover */
	const dismiss = () => {
		clearShowTimer();
		clearHideTimer();
		clearFadeTimer();
		if (abortCtrl) {
			abortCtrl.abort();
			abortCtrl = null;
		}
		setState(null);
	};

	/** Start a delayed hide with fade-out */
	const hide = () => {
		clearShowTimer();
		clearHideTimer();
		hideTimer = setTimeout(() => {
			hideTimer = null;
			const cur = state();
			if (!cur) return;
			setState({ ...cur, fading: true });
			clearFadeTimer();
			fadeTimer = setTimeout(() => {
				fadeTimer = null;
				setState(null);
			}, FADE_DURATION);
		}, HIDE_DELAY);
	};

	/** Cancel any pending hide (called when mouse enters popover or re-enters trigger) */
	const cancelHide = () => {
		clearHideTimer();
		clearFadeTimer();
		const cur = state();
		if (cur?.fading) {
			setState({ ...cur, fading: false });
		}
	};

	const show = (noteId: string, x: number, y: number, opts?: ShowOptions) => {
		const id = noteId.trim();
		if (id === "") return;

		cancelHide();

		const cur = state();
		if (cur && cur.noteId === id) {
			// Update actions/onOpen if re-shown (e.g. click after hover)
			if (opts?.actions || opts?.onOpen) {
				setState({
					...cur,
					actions: opts.actions ?? cur.actions,
					onOpen: opts.onOpen ?? cur.onOpen,
				});
			}
			return;
		}

		const doShow = () => {
			void loadAndShow(id, x, y, opts);
		};

		clearShowTimer();
		if (opts?.immediate) {
			doShow();
		} else {
			showTimer = setTimeout(doShow, SHOW_DELAY);
		}
	};

	const loadAndShow = async (
		noteId: string,
		x: number,
		y: number,
		opts?: ShowOptions,
	) => {
		const base: Omit<PreviewState, "data" | "loading"> = {
			noteId,
			x,
			y,
			fading: false,
			actions: opts?.actions ?? [],
			onOpen: opts?.onOpen,
		};

		const cached = cache.get(noteId);
		if (cached) {
			setState({ ...base, data: cached, loading: false });
			return;
		}

		setState({ ...base, data: null, loading: true });

		if (abortCtrl) abortCtrl.abort();
		abortCtrl = new AbortController();

		try {
			const nid = nookId();
			if (!nid) return;
			const res = await apiFetch(`/api/nooks/${nid}/notes/${noteId}`, {
				method: "GET",
				signal: abortCtrl.signal,
			});
			if (!res.ok) throw new Error("fetch failed");
			const json = (await res.json()) as {
				note?: {
					id: string;
					title: string;
					content: string;
					type?: string;
					type_id?: string;
				};
			};
			const n = json.note;
			if (!n) throw new Error("no note");

			const data: NotePreviewData = {
				id: n.id,
				title: n.title,
				content: n.content,
				type: n.type ?? "anything",
			};
			cache.set(noteId, data);
			const cur = state();
			if (cur && cur.noteId === noteId) {
				setState({ ...cur, data, loading: false });
			}
		} catch {
			const cur = state();
			if (cur && cur.noteId === noteId) {
				setState(null);
			}
		}
	};

	/** Invalidate a cached entry (e.g. after editing) */
	const invalidate = (noteId: string) => cache.delete(noteId);

	function PreviewPopover() {
		let overlayEl: HTMLDivElement | undefined;

		// Click-outside and Escape dismiss for action-mode popovers
		const onPointerDown = (e: PointerEvent) => {
			if (!overlayEl || overlayEl.contains(e.target as Node)) return;
			// Only dismiss on outside click if popover has actions (was click-triggered)
			const cur = state();
			if (cur && cur.actions.length > 0) dismiss();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") dismiss();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		});

		return (
			<Show when={state()}>
				{(s) => {
					const left = () => Math.min(s().x, window.innerWidth - 340);
					const top = () => {
						const y = s().y + 12;
						return y + 180 > window.innerHeight ? s().y - 180 : y;
					};

					const handleHeaderClick = (e: MouseEvent) => {
						const fn = s().onOpen;
						if (!fn) return;
						// Ctrl/Cmd+click: let browser handle (new tab via href)
						if (e.ctrlKey || e.metaKey) return;
						e.preventDefault();
						dismiss();
						fn(s().noteId);
					};

					const handleAction = (action: PreviewAction) => {
						dismiss();
						action.onClick();
					};

					const headerHref = () =>
						`/nooks/${encodeURIComponent(nookId())}/notes/${encodeURIComponent(s().noteId)}`;

					return (
						<Portal mount={document.body}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: popover hover keeps preview open */}
							<div
								ref={overlayEl}
								class={`${styles.overlay} ${s().fading ? styles.fadeOut : ""}`}
								style={{ left: `${left()}px`, top: `${top()}px` }}
								onMouseEnter={cancelHide}
								onMouseLeave={hide}
							>
								<Show
									when={!s().loading && s().data}
									fallback={<div class={styles.loading}>Loading...</div>}
								>
									{(data) => {
										const snippet = () => {
											const plain = stripMarkdown(data().content);
											return plain.length > 300
												? `${plain.slice(0, 300)}...`
												: plain;
										};
										const typeLabel = () => {
											const t = data().type;
											if (t === "person") return "Person";
											if (t === "file") return "File";
											return "Note";
										};

										return (
											<>
												<a
													href={headerHref()}
													class={`${styles.header} ${s().onOpen ? styles.headerClickable : ""}`}
													onClick={handleHeaderClick}
												>
													<div class={styles.headerContent}>
														<div>
															<div class={styles.title}>
																{data().title || "(untitled)"}
															</div>
															<div class={styles.meta}>
																<span class={styles.typeBadge}>
																	{typeLabel()}
																</span>
																<span class={styles.dot}>&middot;</span>
																<span>{data().id.slice(0, 8)}...</span>
															</div>
														</div>
														<Show when={s().onOpen}>
															<svg
																class={styles.openIcon}
																width="14"
																height="14"
																viewBox="0 0 14 14"
																fill="none"
															>
																<title>Open note</title>
																<path
																	d="M2 7h10M7 2l5 5-5 5"
																	stroke="currentColor"
																	stroke-width="1.5"
																	stroke-linecap="round"
																	stroke-linejoin="round"
																/>
															</svg>
														</Show>
													</div>
												</a>
												<Show when={snippet().length > 0}>
													<div class={styles.body}>{snippet()}</div>
												</Show>
												<Show when={s().actions.length > 0}>
													<div class={styles.divider} />
													<For each={s().actions}>
														{(action) => (
															<button
																type="button"
																class={`${styles.actionBtn} ${action.danger ? styles.actionDanger : ""}`}
																onClick={() => handleAction(action)}
															>
																{action.label}
															</button>
														)}
													</For>
												</Show>
											</>
										);
									}}
								</Show>
							</div>
						</Portal>
					);
				}}
			</Show>
		);
	}

	return { show, hide, dismiss, cancelHide, invalidate, PreviewPopover };
}

/**
 * Helper: attach note-preview hover to any element via `onMouseEnter` / `onMouseLeave`.
 * Returns props to spread onto the element.
 */
export function notePreviewHandlers(
	preview: {
		show: (id: string, x: number, y: number, opts?: ShowOptions) => void;
		hide: () => void;
	},
	noteId: () => string,
	opts?: ShowOptions,
) {
	return {
		onMouseEnter: (e: MouseEvent) =>
			preview.show(noteId(), e.clientX, e.clientY, opts),
		onMouseLeave: () => preview.hide(),
	};
}
