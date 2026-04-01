import { createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { createNotePreview } from "../../components/NotePreview";
import { MOBILE_PANELS, type MobilePanel, useUi } from "../../ui/UiContext";
import styles from "./NookDefaultLayout.module.css";
import { NookGraphPanel } from "./NookGraphPanel";
import { NookLinksAndMentionsPanel } from "./NookLinksAndMentionsPanel";
import { NookMainPanel } from "./NookMainPanel";
import { NookMarkdownView } from "./NookMarkdownView";
import type { NookStore } from "./store";

export type NookDefaultLayoutProps = {
	nookId: string;
	store: NookStore;
	showGraph: boolean;
};

export type NotePreviewController = ReturnType<typeof createNotePreview>;

const PANEL_LABELS: Record<MobilePanel, string> = {
	content: "Note",
	links: "Links",
	graph: "Graph",
	chat: "Chat",
	markdown: "Markdown",
};

export function NookDefaultLayout(props: NookDefaultLayoutProps) {
	const ui = useUi();
	const notePreview = createNotePreview(() => props.nookId);
	let layoutEl: HTMLDivElement | undefined;

	// Switch to content panel when a different note is selected (mobile)
	let prevSelectedId = "";
	createEffect(() => {
		const id = props.store.selectedId();
		if (id !== "" && id !== prevSelectedId) {
			prevSelectedId = id;
			if (ui.activePanel() !== "content") {
				ui.setActivePanel("content");
			}
		}
		if (id === "") {
			prevSelectedId = "";
		}
	});

	// Swipe gesture (lazy-loaded, mobile only)
	onMount(() => {
		const mq = window.matchMedia("(max-width: 1024px)");
		let cleanup: (() => void) | null = null;

		const setup = () => {
			if (!mq.matches || !layoutEl) {
				cleanup?.();
				cleanup = null;
				return;
			}
			void import("@use-gesture/vanilla").then(({ DragGesture }) => {
				if (!layoutEl) return;
				const gesture = new DragGesture(
					layoutEl,
					({ swipe: [swipeX], event }) => {
						// Don't swipe if user is interacting with an editable input/editor
						const target = event?.target as HTMLElement | null;
						if (!target) return;
						// Allow swipe on readonly textareas (e.g. markdown view)
						if (target instanceof HTMLTextAreaElement && target.readOnly) {
							// allow swipe
						} else if (
							target.closest(
								"input, textarea, [contenteditable], .milkdown, .ProseMirror",
							)
						) {
							return;
						}

						if (swipeX === -1) ui.nextPanel();
						else if (swipeX === 1) ui.prevPanel();
					},
					{
						axis: "x",
						filterTaps: true,
						swipe: { distance: 50, velocity: 0.3 },
					},
				);
				cleanup = () => gesture.destroy();
			});
		};

		setup();
		const onChange = () => setup();
		mq.addEventListener("change", onChange);
		onCleanup(() => {
			mq.removeEventListener("change", onChange);
			cleanup?.();
		});
	});

	return (
		<>
			<div
				ref={layoutEl}
				class={styles.layout}
				data-active-panel={ui.activePanel()}
			>
				{/* Main scrollable area: content + links together on desktop */}
				<div class={styles.mainScroll}>
					<div class={styles.mainScrollInner}>
						<div class={styles.panelContent}>
							<NookMainPanel store={props.store} notePreview={notePreview} />
						</div>
						<div class={styles.panelLinks}>
							<NookLinksAndMentionsPanel
								store={props.store}
								notePreview={notePreview}
							/>
						</div>
					</div>
				</div>

				{/* Graph panel — render if desktop toggle is on OR mobile panel is active */}
				<Show when={props.showGraph || ui.activePanel() === "graph"}>
					<div class={styles.panelGraph}>
						<NookGraphPanel store={props.store} />
					</div>
				</Show>

				{/* Chat panel — render if desktop toggle is on OR mobile panel is active */}
				<Show when={ui.chatPanelOpen() || ui.activePanel() === "chat"}>
					<div class={styles.panelChat}>
						<ChatPanel
							nookId={props.nookId}
							currentNoteId={props.store.selectedId() || undefined}
							currentNoteTitle={props.store.title() || undefined}
							currentNoteType={props.store.type() || undefined}
							onClose={() => {
								ui.toggleChatPanel();
								ui.setActivePanel("content");
							}}
							onNavigateToNote={(id) => void props.store.onNoteLinkClick(id)}
							notePreview={notePreview}
						/>
					</div>
				</Show>

				{/* Markdown source panel — mobile only */}
				<div class={styles.panelMarkdown}>
					<NookMarkdownView store={props.store} />
				</div>
			</div>

			{/* Panel indicator dots — mobile only (CSS hides on desktop) */}
			<div class={styles.panelIndicator}>
				<For each={MOBILE_PANELS}>
					{(panel) => (
						<button
							type="button"
							class={`${styles.dot} ${ui.activePanel() === panel ? styles.dotActive : ""}`}
							onClick={() => ui.setActivePanel(panel)}
							title={PANEL_LABELS[panel]}
						/>
					)}
				</For>
				<span class={styles.dotLabel}>{PANEL_LABELS[ui.activePanel()]}</span>
			</div>

			<notePreview.PreviewPopover />
		</>
	);
}
