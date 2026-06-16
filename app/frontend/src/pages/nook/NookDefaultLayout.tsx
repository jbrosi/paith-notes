import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createNotePreview } from "../../components/NotePreview";
import { attachSwipe } from "../../ui/swipe";
import { useUi } from "../../ui/UiContext";
import { NoteAttributeFields } from "./components/NoteAttributeFields";
import { NotePreviewProvider } from "./NookContext";
import { NookDashboard } from "./NookDashboard";
import styles from "./NookDefaultLayout.module.css";
import { NookMainPanel } from "./NookMainPanel";
import type { NookStore } from "./store";
import type { Panel } from "./types";

export type NookDefaultLayoutProps = {
	nookId: string;
	store: NookStore;
	onSettings?: () => void;
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

	// Resolve panels from the current note's type layout
	const resolvedPanels = createMemo((): Panel[] => {
		const typeId = props.store.typeId();
		if (!typeId) return [{ key: "main", position: "main", attributes: [] }];
		return props.store.resolveTypeLayout(typeId);
	});

	const mainPanel = createMemo(
		() =>
			resolvedPanels().find((p) => p.position === "main") ?? {
				key: "main",
				position: "main" as const,
				attributes: [],
			},
	);

	const rightPanels = createMemo(() =>
		resolvedPanels()
			.filter((p) => p.position === "side-right")
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
	);

	const leftPanels = createMemo(() =>
		resolvedPanels()
			.filter((p) => p.position === "side-left")
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
	);

	const sidePanels = createMemo(() =>
		resolvedPanels()
			.filter((p) => p.position !== "main")
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
	);

	// Show sidebars only when panels exist and toggle is on
	const showRightSidebar = createMemo(
		() => ui.sidebarRightOpen() && rightPanels().length > 0,
	);
	const showLeftSidebar = createMemo(
		() => ui.sidebarLeftOpen() && leftPanels().length > 0,
	);

	const [activeSideTab, setActiveSideTab] = createSignal("");

	// Per-side width signals, hydrated from localStorage and written
	// back on every change so the next reload remembers the user's
	// preferred sidebar width.
	const RIGHT_WIDTH_KEY = "paith-notes:rightSidebarWidth";
	const LEFT_WIDTH_KEY = "paith-notes:leftSidebarWidth";
	const SIDEBAR_DEFAULT = 340;
	const readStoredWidth = (k: string): number => {
		try {
			const v = window.localStorage.getItem(k);
			const n = v !== null ? parseInt(v, 10) : NaN;
			return Number.isFinite(n) && n >= 200 ? n : SIDEBAR_DEFAULT;
		} catch {
			return SIDEBAR_DEFAULT;
		}
	};
	const [rightSidebarWidth, setRightSidebarWidthSignal] = createSignal(
		readStoredWidth(RIGHT_WIDTH_KEY),
	);
	const [leftSidebarWidth, setLeftSidebarWidthSignal] = createSignal(
		readStoredWidth(LEFT_WIDTH_KEY),
	);
	const setRightSidebarWidth = (w: number) => {
		setRightSidebarWidthSignal(w);
		try {
			window.localStorage.setItem(RIGHT_WIDTH_KEY, String(w));
		} catch {
			/* ignore */
		}
	};
	const setLeftSidebarWidth = (w: number) => {
		setLeftSidebarWidthSignal(w);
		try {
			window.localStorage.setItem(LEFT_WIDTH_KEY, String(w));
		} catch {
			/* ignore */
		}
	};

	// Update mobile panels when resolved panels change
	createEffect(() => {
		const panels = resolvedPanels();
		ui.setMobilePanels(panels.map((p) => p.key));
	});

	// Switch to main panel when a different note is selected (mobile)
	let prevSelectedId = "";
	createEffect(() => {
		const id = props.store.selectedId();
		const main = mainPanel();
		if (id !== "" && id !== prevSelectedId) {
			prevSelectedId = id;
			if (ui.activePanel() !== main.key) {
				ui.setActivePanel(main.key);
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

	const panelLabel = (panel: Panel) => panel.label || panel.key;

	// Remove stale activeSideTab — ensure valid across left+right
	createEffect(() => {
		const all = sidePanels();
		if (all.length > 0 && !all.some((p) => p.key === activeSideTab())) {
			setActiveSideTab(all[0].key);
		}
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
				<div ref={layoutEl} class={styles.layout}>
					{/* Desktop: left sidebar */}
					<Show when={showLeftSidebar()}>
						<SidebarContainer
							panels={leftPanels()}
							activeSideTab={activeSideTab}
							setActiveSideTab={setActiveSideTab}
							store={props.store}
							panelLabel={panelLabel}
							side="left"
							width={leftSidebarWidth}
							setWidth={setLeftSidebarWidth}
						/>
					</Show>

					{/* Main scrollable area — hidden on mobile when another panel is active */}
					<div
						class={styles.mainScroll}
						classList={{
							[styles.mobileHidden]: ui.activePanel() !== mainPanel().key,
						}}
					>
						<div class={styles.mainScrollInner}>
							<div class={styles.panelContent}>
								<NookMainPanel
									store={props.store}
									panelFilter={mainPanel().key}
								/>
							</div>
						</div>
					</div>

					{/* Desktop: right sidebar */}
					<Show when={showRightSidebar()}>
						<SidebarContainer
							panels={rightPanels()}
							activeSideTab={activeSideTab}
							setActiveSideTab={setActiveSideTab}
							store={props.store}
							panelLabel={panelLabel}
							side="right"
							width={rightSidebarWidth}
							setWidth={setRightSidebarWidth}
						/>
					</Show>

					{/* Mobile: side panels as swipeable views (shown/hidden via classList) */}
					<For each={sidePanels()}>
						{(panel) => (
							<div
								class={styles.mobilePanel}
								classList={{
									[styles.mobilePanelActive]: ui.activePanel() === panel.key,
								}}
							>
								<div style={{ padding: "8px 0" }}>
									<h3
										style={{
											margin: "0 0 8px",
											"font-size": "14px",
											color: "var(--color-text-secondary)",
										}}
									>
										{panelLabel(panel)}
									</h3>
									<NoteAttributeFields
										store={props.store}
										panelFilter={panel.key}
									/>
								</div>
							</div>
						)}
					</For>
				</div>

				{/* Panel indicator dots — mobile only (CSS hides on desktop) */}
				<div class={styles.panelIndicator}>
					<For each={ui.mobilePanels()}>
						{(panelKey) => {
							const panel = () =>
								resolvedPanels().find((p) => p.key === panelKey);
							return (
								<button
									type="button"
									class={`${styles.dot} ${ui.activePanel() === panelKey ? styles.dotActive : ""}`}
									onClick={() => ui.setActivePanel(panelKey)}
									title={panel()?.label || panelKey}
								/>
							);
						}}
					</For>
					<span class={styles.dotLabel}>
						{(() => {
							const panel = resolvedPanels().find(
								(p) => p.key === ui.activePanel(),
							);
							return panel?.label || ui.activePanel();
						})()}
					</span>
				</div>
			</Show>

			<notePreview.PreviewPopover />
		</NotePreviewProvider>
	);
}

/** Reusable sidebar container with tabs (used for both left and right sidebars). */
function SidebarContainer(props: {
	panels: Panel[];
	activeSideTab: () => string;
	setActiveSideTab: (key: string) => void;
	store: NookStore;
	panelLabel: (panel: Panel) => string;
	side: "left" | "right";
	width: () => number;
	setWidth: (w: number) => void;
}) {
	// Drag-to-resize. The handle sits on the inner edge of the
	// sidebar (right's left edge, left's right edge) and updates
	// the width signal while the mouse is down. Width persistence
	// lives in the parent via localStorage so reopens remember it.
	const SIDEBAR_MIN = 240;
	const SIDEBAR_MAX_RATIO = 0.6; // never more than 60% of viewport
	const onResizeStart = (e: MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = props.width();
		const onMove = (ev: MouseEvent) => {
			// For the right sidebar, dragging left (delta > 0) widens it;
			// for the left sidebar, dragging right (delta > 0) widens it.
			const delta =
				props.side === "right" ? startX - ev.clientX : ev.clientX - startX;
			const maxW = Math.floor(window.innerWidth * SIDEBAR_MAX_RATIO);
			const next = Math.max(SIDEBAR_MIN, Math.min(maxW, startWidth + delta));
			props.setWidth(next);
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	return (
		<div class={styles.sidePanel} style={{ width: `${props.width()}px` }}>
			<Show when={props.side === "right"}>
				<div
					class={styles.sideResizeHandleLeft}
					onMouseDown={onResizeStart}
					aria-hidden="true"
				/>
			</Show>
			<Show when={props.panels.length > 1}>
				<div class={styles.sidePanelTabs}>
					<For each={props.panels}>
						{(panel) => (
							<button
								type="button"
								class={`${styles.sidePanelTab} ${props.activeSideTab() === panel.key ? styles.sidePanelTabActive : ""}`}
								onClick={() => props.setActiveSideTab(panel.key)}
							>
								{props.panelLabel(panel)}
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={props.panels.length === 1}>
				<div class={styles.sidePanelHeader}>
					{props.panelLabel(props.panels[0])}
				</div>
			</Show>
			<div class={styles.sidePanelBody}>
				<For each={props.panels}>
					{(panel) => (
						<div
							style={{
								display:
									props.activeSideTab() === panel.key ? undefined : "none",
							}}
						>
							<NoteAttributeFields
								store={props.store}
								panelFilter={panel.key}
							/>
						</div>
					)}
				</For>
			</div>
			<Show when={props.side === "left"}>
				<div
					class={styles.sideResizeHandleRight}
					onMouseDown={onResizeStart}
					aria-hidden="true"
				/>
			</Show>
		</div>
	);
}
