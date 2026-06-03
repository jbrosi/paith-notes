import {
	createEffect,
	createMemo,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createNotePreview } from "../../components/NotePreview";
import { attachSwipe } from "../../ui/swipe";
import { MOBILE_PANELS, type MobilePanel, useUi } from "../../ui/UiContext";
import { NoteHistory } from "./components/NoteHistory";
import { NotePreviewProvider } from "./NookContext";
import { NookDashboard } from "./NookDashboard";
import styles from "./NookDefaultLayout.module.css";
import { NookGraphPanel } from "./NookGraphPanel";
import { NookMainPanel } from "./NookMainPanel";
import { NookMarkdownView } from "./NookMarkdownView";
import type { NookStore } from "./store";

export type NookDefaultLayoutProps = {
	nookId: string;
	store: NookStore;
	showGraph: boolean;
	onSettings?: () => void;
};

const PANEL_LABELS: Record<MobilePanel, string> = {
	content: "Note",
	history: "History",
	graph: "Graph",
	markdown: "Markdown",
};

export function NookDefaultLayout(props: NookDefaultLayoutProps) {
	const ui = useUi();
	const notePreview = createNotePreview(() => props.nookId);
	let layoutEl: HTMLDivElement | undefined;
	let dashboardFileInput: HTMLInputElement | undefined;

	const hasNote = createMemo(
		() => props.store.selectedId() !== "" || props.store.mode() === "edit",
	);

	const handleNewNote = () => {
		props.store.newNote();
		props.store.setMode("edit");
		ui.setMode("edit");
	};

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

	// Swipe gesture (mobile only)
	onMount(() => {
		const mq = window.matchMedia("(max-width: 1024px)");
		let cleanup: (() => void) | null = null;

		const setup = () => {
			cleanup?.();
			cleanup = null;
			if (!mq.matches || !layoutEl) return;
			cleanup = attachSwipe(
				layoutEl,
				(dir) => {
					if (dir === -1) ui.nextPanel();
					else ui.prevPanel();
				},
				{ distance: 50, velocity: 0.3 },
			);
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
		<NotePreviewProvider controller={notePreview}>
			<Show
				when={hasNote()}
				fallback={
					<div
						style={{
							height: "100%",
							overflow: "hidden",
							display: "flex",
							"flex-direction": "column",
						}}
					>
						<input
							ref={dashboardFileInput}
							type="file"
							style={{ display: "none" }}
							onChange={(e) => {
								const f = e.currentTarget.files?.[0];
								if (f) void props.store.quickUploadFile(f);
								e.currentTarget.value = "";
							}}
						/>
						<div class={styles.mainScroll}>
							<NookDashboard
								store={props.store}
								onNewNote={handleNewNote}
								onUploadFile={() => dashboardFileInput?.click()}
								onSettings={props.onSettings}
							/>
						</div>
					</div>
				}
			>
				<div
					ref={layoutEl}
					class={styles.layout}
					data-active-panel={ui.activePanel()}
				>
					{/* Main scrollable area: content + history together on desktop */}
					<div class={styles.mainScroll}>
						<div class={styles.mainScrollInner}>
							<div class={styles.panelContent}>
								<NookMainPanel store={props.store} />
							</div>
							<Show when={props.store.selectedId() !== ""}>
								<div class={styles.panelHistory}>
									<NoteHistory store={props.store} />
								</div>
							</Show>
						</div>
					</div>

					{/* Graph panel — render if desktop toggle is on OR mobile panel is active */}
					<Show when={props.showGraph || ui.activePanel() === "graph"}>
						<div class={styles.panelGraph}>
							<NookGraphPanel
								store={props.store}
								onClose={() => {
									ui.toggleGraphPanel();
									ui.setActivePanel("content");
								}}
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
			</Show>

			<notePreview.PreviewPopover />
		</NotePreviewProvider>
	);
}
