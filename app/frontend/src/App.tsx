import type { RouteSectionProps } from "@solidjs/router";
import { createResource, createSignal, onCleanup, Show } from "solid-js";
import styles from "./App.module.css";
import { useAuth } from "./auth/AuthContext";
import { apiFetch } from "./auth/keycloak";
import { useApi } from "./auth/useApi";
import { Button } from "./components/Button";
import { ChatPanel } from "./components/chat/ChatPanel";
import { ImageLightbox } from "./components/ImageLightbox";
import { MobileChatToggle } from "./components/MobileChatToggle";
import { Nav } from "./components/Nav";
import { createNotePreview } from "./components/NotePreview";
import { NookProvider, useNook } from "./pages/nook/NookContext";
import { attachSwipe } from "./ui/swipe";
import { useUi } from "./ui/UiContext";

function AppContent(props: RouteSectionProps) {
	const ui = useUi();
	const auth = useAuth();
	const api = useApi();
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
			<Show when={api.sessionExpired()}>
				<div
					style={{
						padding: "10px 16px",
						background: "#fef3c7",
						border: "1px solid #f59e0b",
						display: "flex",
						"align-items": "center",
						"justify-content": "space-between",
						gap: "12px",
						"font-size": "0.85rem",
					}}
				>
					<span>
						Your session has expired. Please log in again to continue.
					</span>
					<Button variant="primary" size="small" onClick={() => auth.login()}>
						Log in
					</Button>
				</div>
			</Show>
			<div class={styles.appBody}>
				<div class={styles.appContent}>{props.children}</div>
				<Show when={ui.chatPanelOpen()}>
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
							currentNoteType={undefined}
							// Getters (not values) so ChatPanel snapshots at
							// send-time, not at mount. The user may have typed
							// more since the panel rendered — the AI should see
							// the buffer as it is when they hit send.
							currentNoteContent={() => store()?.content() ?? ""}
							currentNoteVersion={() => store()?.noteVersion() ?? 0}
							currentNoteInEditMode={() =>
								store()?.mode() === "edit" && !!store()?.selectedId()
							}
							onEditCurrentEditor={(find, replace) =>
								store()?.editCurrentEditor(find, replace) ?? {
									applied: false,
									error: "no active nook store",
								}
							}
							currentPath={window.location.pathname}
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
			{/* Persistent bottom-right FAB — mobile only via CSS media query.
			    Hidden on desktop where the Nav "Chat" button + sidebar make
			    the toggle obvious. */}
			<MobileChatToggle />
		</div>
	);
}

export default function App(props: RouteSectionProps) {
	return (
		<NookProvider>
			<AppContent {...props} />
			{/* Global fullscreen image viewer — opened from anywhere via
			    openImageLightbox(). Mounted once at the root so its
			    portal + global keyboard listener live for the whole
			    session, regardless of which route is active. */}
			<ImageLightbox />
		</NookProvider>
	);
}
