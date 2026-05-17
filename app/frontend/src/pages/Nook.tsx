import { useNavigate, useParams } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import styles from "../App.module.css";

import { apiFetch } from "../auth/keycloak";
import { Button } from "../components/Button";
import { useUi } from "../ui/UiContext";
import { useNook } from "./nook/NookContext";
import { NookActivityFeed } from "./nook/NookActivityFeed";
import { NookDefaultLayout } from "./nook/NookDefaultLayout";
import { NookNoteHistoryPage } from "./nook/NookNoteHistoryPage";
import { NookUnlinkedNotes } from "./nook/NookUnlinkedNotes";
import { NookGraphPanel } from "./nook/NookGraphPanel";
import { NookLinksPanel } from "./nook/NookLinksPanel";
import {
	applyNookSeeds,
	NookSettingsLanding,
} from "./nook/NookSettingsLanding";
import { NookTypesSettingsView } from "./nook/NookTypesSettingsView";
import { createNookStore } from "./nook/store";

export default function Nook() {
	const params = useParams();
	const navigate = useNavigate();
	const ui = useUi();
	const nookCtx = useNook();
	const nookId = createMemo(() => String(params.nookId ?? ""));
	const subPath = createMemo(() =>
		String((params as { path?: string }).path ?? ""),
	);
	const normalizedSubPath = createMemo(() =>
		subPath().replace(/^\/+/u, "").replace(/\/+$/u, ""),
	);
	const store = createNookStore(nookId);
	const [nookName, setNookName] = createSignal("");
	const [nookRole, setNookRole] = createSignal("unknown");
	createEffect(() => {
		const id = nookId();
		if (id) {
			ui.loadNookAccent(id);
			applyNookSeeds(id);
		}
	});
	createEffect(() => {
		nookCtx.setStore(store);
	});

	onMount(() => {
		void (async () => {
			try {
				const res = await apiFetch("/api/nooks", { method: "GET" });
				if (!res.ok) return;
				const body = (await res.json()) as { nooks?: unknown };
				const list = Array.isArray(body?.nooks) ? body.nooks : [];
				const id = nookId();
				for (const n of list) {
					if (!n || typeof n !== "object") continue;
					const obj = n as Record<string, unknown>;
					if (typeof obj.id === "string" && obj.id === id) {
						{
							const name = typeof obj.name === "string" ? obj.name : "";
							setNookName(name);
							store.setNookName(name);
							store.cacheNookName(id, name);
						}

						if (typeof obj.role === "string") {
							setNookRole(obj.role);
							store.setNookRole(obj.role);
						}
						break;
					}
				}
			} catch {
				// best-effort
			}
		})();
	});
	onCleanup(() => {
		if (nookCtx.store() === store) {
			nookCtx.setStore(null);
		}
	});
	onMount(() => {
		const handler = (e: BeforeUnloadEvent) => {
			if (store.isDirty()) {
				e.preventDefault();
			}
		};
		window.addEventListener("beforeunload", handler);
		onCleanup(() => window.removeEventListener("beforeunload", handler));
	});

	let lastUrlSelectRequestId = 0;

	// Wire up navigation: store.onNoteLinkClick → router navigate
	store.setNavigator((noteId: string, targetNookId?: string) => {
		const nook = targetNookId || nookId();
		navigate(
			`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(noteId)}`,
		);
	});

	const typeEditId = createMemo(() => {
		const p = normalizedSubPath();
		if (p === "") return "";
		const parts = p.split("/").filter(Boolean);
		if (
			parts.length === 4 &&
			parts[0] === "settings" &&
			parts[1] === "types" &&
			parts[3] === "edit"
		) {
			return String(parts[2] ?? "");
		}
		return "";
	});

	const showTypesSettings = createMemo(() => {
		const p = normalizedSubPath();
		return p === "settings/types" || p.startsWith("settings/types/");
	});

	const showLinks = createMemo(() => normalizedSubPath() === "settings/links");
	const showActivity = createMemo(() => normalizedSubPath() === "settings/activity");
	const showUnlinked = createMemo(() => normalizedSubPath() === "settings/unlinked");
	const showSettings = createMemo(() => normalizedSubPath() === "settings");

	const fullscreenGraphNoteId = createMemo(() => {
		const m = normalizedSubPath().match(/^graph\/([^/]+)$/);
		return m?.[1] ? String(m[1]) : "";
	});

	const isGraphFullscreen = createMemo(
		() => fullscreenGraphNoteId().trim() !== "",
	);

	const selectedNoteIdFromPath = createMemo(() => {
		const m = normalizedSubPath().match(/^notes\/([^/]+?)(?:\/v\/\d+|\/history)?$/);
		return m?.[1] ? String(m[1]) : "";
	});

	const selectedVersionFromPath = createMemo(() => {
		const m = normalizedSubPath().match(/^notes\/[^/]+\/v\/(\d+)$/);
		return m?.[1] ? Number(m[1]) : null;
	});

	const showNoteHistory = createMemo(() =>
		/^notes\/[^/]+\/history$/.test(normalizedSubPath()),
	);

	// URL → store: URL is the single source of truth for which note is selected.
	// The store never drives navigation — only follows the URL.
	createEffect(() => {
		const id = (
			isGraphFullscreen() ? fullscreenGraphNoteId() : selectedNoteIdFromPath()
		).trim();

		if (id === "") {
			if (untrack(() => store.selectedId()) !== "") {
				store.setSelectedId("");
			}
			return;
		}

		if (untrack(() => store.selectedId()) === id) return;

		const requestId = ++lastUrlSelectRequestId;
		void (async () => {
			try {
				await store.loadNoteById(id);
			} catch {
				if (requestId === lastUrlSelectRequestId) {
					store.setSelectedId("");
				}
			}
		})();
	});

	// Sync version from URL to store
	createEffect(() => {
		const version = selectedVersionFromPath();
		const currentStoreVersion = untrack(() => store.selectedVersion());
		if (version === currentStoreVersion) return;

		if (version === null) {
			if (currentStoreVersion !== null) {
				store.setSelectedVersion(null);
			}
		} else {
			void store.viewVersion(version, true);
		}
	});

	createEffect(() => {
		const t = store.title().trim();
		const nook = nookName().trim() || "Paith Notes";
		if (store.selectedId().trim() === "") {
			document.title = `${nook} | Paith Notes`;
			return;
		}
		document.title =
			t === "" ? `${nook} | Paith Notes` : `${t} | ${nook} | Paith Notes`;
	});

	const goBackToNoteOrNook = () => {
		const n = nookId().trim();
		if (n === "") return;
		const note = store.selectedId().trim();
		if (note !== "") {
			navigate(
				`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(note)}`,
			);
			return;
		}
		navigate(`/nooks/${encodeURIComponent(n)}`);
	};

	const openLinksSettings = () => {
		const n = nookId().trim();
		if (n === "") return;
		navigate(`/nooks/${encodeURIComponent(n)}/settings/links`);
	};

	const openTypesSettings = () => {
		const n = nookId().trim();
		if (n === "") return;
		navigate(`/nooks/${encodeURIComponent(n)}/settings/types`);
	};

	return (
		<main
			class={styles["container-wide"]}
			style={{
				height: "100%",
				overflow: "hidden",
				"padding-top": "0",
				"padding-bottom": "0",
				"padding-right": "0",
			}}
		>
			<Show
				when={showLinks()}
				fallback={
					<Show
						when={showActivity()}
						fallback={
							<Show
								when={showUnlinked()}
								fallback={
							<Show
								when={showSettings()}
								fallback={
									<Show
										when={showTypesSettings()}
										fallback={
											<Show
												when={showNoteHistory()}
												fallback={
													<Show
														when={isGraphFullscreen()}
														fallback={
															<NookDefaultLayout
																nookId={nookId()}
																store={store}
																showGraph={ui.graphPanelOpen()}
																onSettings={() =>
																	navigate(
																		`/nooks/${encodeURIComponent(nookId())}/settings`,
																	)
																}
															/>
														}
													>
														<div style={{ width: "100%" }}>
															<NookGraphPanel store={store} fullscreen={true} />
														</div>
													</Show>
												}
											>
												<NookNoteHistoryPage store={store} />
											</Show>
										}
									>
										<NookTypesSettingsView
											nookId={nookId()}
											store={store}
											typeEditId={typeEditId()}
											onClose={goBackToNoteOrNook}
										/>
									</Show>
								}
							>
								<NookSettingsLanding
									nookId={nookId()}
									nookName={nookName()}
									nookRole={nookRole()}
									onClose={goBackToNoteOrNook}
									onOpenLinks={openLinksSettings}
									onOpenTypes={openTypesSettings}
									onOpenActivity={() => {
										const n = nookId().trim();
										if (n !== "") navigate(`/nooks/${encodeURIComponent(n)}/settings/activity`);
									}}
									onOpenUnlinked={() => {
										const n = nookId().trim();
										if (n !== "") navigate(`/nooks/${encodeURIComponent(n)}/settings/unlinked`);
									}}
									onNameSaved={(name) => {
										setNookName(name);
										store.setNookName(name);
									}}
								/>
							</Show>
						}
					>
						<NookUnlinkedNotes
							nookId={nookId()}
							store={store}
							onClose={goBackToNoteOrNook}
						/>
					</Show>
						}
					>
						<NookActivityFeed
							nookId={nookId()}
							onClose={goBackToNoteOrNook}
						/>
					</Show>
				}
			>
				<div style={{ width: "100%" }}>
					<div
						style={{
							display: "flex",
							"justify-content": "flex-end",
							"margin-bottom": "12px",
						}}
					>
						<Button
							variant="secondary"
							size="small"
							onClick={goBackToNoteOrNook}
						>
							Close
						</Button>
					</div>
					<NookLinksPanel store={store} />
				</div>
			</Show>
		</main>
	);
}
