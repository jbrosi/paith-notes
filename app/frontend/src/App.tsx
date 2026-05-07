import type { RouteSectionProps } from "@solidjs/router";
import { createResource, createSignal, onCleanup, Show } from "solid-js";
import styles from "./App.module.css";
import { apiFetch } from "./auth/keycloak";
import { ChatPanel } from "./components/chat/ChatPanel";
import { Nav } from "./components/Nav";
import { createNotePreview } from "./components/NotePreview";
import { NookProvider, useNook } from "./pages/nook/NookContext";
import { attachSwipe } from "./ui/swipe";
import { useUi } from "./ui/UiContext";

function AppContent(props: RouteSectionProps) {
	const ui = useUi();
	const nook = useNook();
	const store = () => nook.store();

	// Resolve AI memory nook ID once (for chat panel)
	const [aiMemoryNook] = createResource(async () => {
		try {
			const res = await apiFetch("/api/nooks/ai-memory", {
				method: "GET",
			});
			if (!res.ok) return null;
			const body = (await res.json()) as {
				nook?: { id: string; name: string };
			};
			const nookData = body?.nook ?? null;
			if (nookData) {
				store()?.cacheNookName(nookData.id, nookData.name);
			}
			return nookData;
		} catch {
			return null;
		}
	});

	const chatNookId = () => aiMemoryNook()?.id ?? "";

	// Note preview for chat panel
	const chatNotePreview = createNotePreview(() => store()?.nookId() ?? "");

	// Resizable chat sidebar
	const [chatWidth, setChatWidth] = createSignal(380);
	const onResizeStart = (e: MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = chatWidth();
		const onMove = (ev: MouseEvent) => {
			const delta = startX - ev.clientX;
			const next = Math.max(
				280,
				Math.min(window.innerWidth * 0.5, startWidth + delta),
			);
			setChatWidth(next);
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
		<div class={styles.appShell}>
			<Nav />
			<div class={styles.appBody}>
				<div class={styles.appContent}>{props.children}</div>
				<Show when={ui.chatPanelOpen() && chatNookId() !== ""}>
					<div
						class={styles.chatSidebar}
						style={{ width: `${chatWidth()}px` }}
						ref={(el) => {
							// Swipe right to close on mobile
							const mq = window.matchMedia("(max-width: 1024px)");
							let cleanup: (() => void) | null = null;
							const setup = () => {
								cleanup?.();
								cleanup = null;
								if (!mq.matches) return;
								cleanup = attachSwipe(
									el,
									(dir) => {
										if (dir === 1) ui.setChatPanelOpen(false);
									},
									{ distance: 60, velocity: 0.25 },
								);
							};
							setup();
							mq.addEventListener("change", setup);
							onCleanup(() => {
								mq.removeEventListener("change", setup);
								cleanup?.();
							});
						}}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle */}
						<div class={styles.chatResizeHandle} onMouseDown={onResizeStart} />
						<ChatPanel
							chatNookId={chatNookId()}
							contextNookId={store()?.nookId() ?? ""}
							currentNoteId={store()?.selectedId() || undefined}
							currentNoteTitle={store()?.title() || undefined}
							currentNoteType={store()?.type() || undefined}
							onClose={() => ui.toggleChatPanel()}
							onNavigateToNote={(id) => {
								void store()?.onNoteLinkClick(id);
							}}
							notePreview={chatNotePreview}
						/>
					</div>
				</Show>
			</div>
			<chatNotePreview.PreviewPopover />
		</div>
	);
}

export default function App(props: RouteSectionProps) {
	return (
		<NookProvider>
			<AppContent {...props} />
		</NookProvider>
	);
}
