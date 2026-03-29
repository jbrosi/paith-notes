import { A, useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../auth/keycloak";
import { useNook } from "../pages/nook/NookContext";
import { useUi } from "../ui/UiContext";
import { Button } from "./Button";
import styles from "./Nav.module.css";
import { NookNotesSearchDropdown } from "./nav/NookNotesSearchDropdown";
import { NookTypeFilterDropdown } from "./nav/NookTypeFilterDropdown";

type NookListItem = {
	id: string;
	name: string;
	role: string;
	is_personal: boolean;
};

export function Nav() {
	const auth = useAuth();
	const ui = useUi();
	const nook = useNook();
	const navigate = useNavigate();
	const location = useLocation();

	const lastSelectedNookStorageKey = "paith.notes.lastSelectedNookId";

	const [nooksOpen, setNooksOpen] = createSignal<boolean>(false);
	const [nooks, setNooks] = createSignal<NookListItem[]>([]);
	const [nooksLoading, setNooksLoading] = createSignal<boolean>(false);
	const [nooksError, setNooksError] = createSignal<string>("");
	const [showCreateNook, setShowCreateNook] = createSignal(false);
	const [newNookName, setNewNookName] = createSignal("");
	const [userName, setUserName] = createSignal<string>("");

	const currentNookId = createMemo(() => {
		const m = location.pathname.match(/^\/nooks\/([^/]+)/);
		return m?.[1] ? String(m[1]) : "";
	});

	const inNookSettings = createMemo(() =>
		/^\/nooks\/[^/]+\/settings(\/|$)/.test(location.pathname),
	);

	const isMarkdownPanel = createMemo(() => ui.activePanel() === "markdown");

	const store = createMemo(() => nook.store());
	const storeReady = createMemo(() => store() !== null);

	const currentNookLabel = createMemo(() => {
		const id = currentNookId();
		if (id === "") {
			const preferred = String(
				window.localStorage.getItem(lastSelectedNookStorageKey) ?? "",
			).trim();
			if (preferred !== "") {
				const foundPreferred = nooks().find((n) => n.id === preferred);
				if (foundPreferred) {
					return foundPreferred.is_personal ? "My notes" : foundPreferred.name;
				}
			}
			return "Select nook";
		}
		const found = nooks().find((n) => n.id === id);
		if (!found) return "Nooks";
		return found.is_personal ? "My notes" : found.name;
	});

	createEffect(() => {
		if (!auth.ready() || !auth.authenticated()) return;
		if (nooksLoading()) return;
		if (nooks().length > 0) return;
		void loadNooks();
	});

	createEffect(() => {
		if (!auth.ready() || !auth.authenticated()) return;
		if (userName() !== "") return;
		void (async () => {
			try {
				const res = await apiFetch("/api/me", { method: "GET" });
				if (!res.ok) return;
				const body = (await res.json()) as {
					user?: { first_name?: string; last_name?: string };
				};
				const first = body?.user?.first_name ?? "";
				const last = body?.user?.last_name ?? "";
				setUserName([first, last].filter(Boolean).join(" ") || "Account");
			} catch {
				// best-effort
			}
		})();
	});

	const loadNooks = async () => {
		if (nooksLoading()) return;
		setNooksError("");
		setNooksLoading(true);
		try {
			const res = await apiFetch("/api/nooks", { method: "GET" });
			if (!res.ok) {
				throw new Error(
					`Failed to load nooks: ${res.status} ${res.statusText}`,
				);
			}
			const body = (await res.json()) as { nooks?: unknown };
			const list = Array.isArray(body?.nooks) ? body.nooks : [];
			const normalized: NookListItem[] = [];
			for (const n of list) {
				if (!n || typeof n !== "object") continue;
				const obj = n as Record<string, unknown>;
				const id = typeof obj.id === "string" ? obj.id : "";
				if (id.trim() === "") continue;
				normalized.push({
					id,
					name: typeof obj.name === "string" ? obj.name : "",
					role: typeof obj.role === "string" ? obj.role : "",
					is_personal: Boolean(obj.is_personal),
				});
			}
			setNooks(normalized);
		} catch (e) {
			setNooksError(e instanceof Error ? e.message : String(e));
		} finally {
			setNooksLoading(false);
		}
	};

	const toggleNooks = () => {
		if (!auth.ready() || !auth.authenticated()) {
			navigate("/nooks");
			return;
		}
		if (currentNookId().trim() === "") {
			const onNooksLandingPage = location.pathname === "/nooks";
			if (!onNooksLandingPage) {
				void (async () => {
					if (nooks().length === 0) {
						await loadNooks();
					}
					const list = nooks();
					const preferred = String(
						window.localStorage.getItem(lastSelectedNookStorageKey) ?? "",
					).trim();
					const preferredExists =
						preferred !== "" && list.some((n) => n.id === preferred);
					const target = preferredExists
						? preferred
						: list[0]?.id
							? String(list[0].id)
							: "";
					if (target !== "") {
						navigate(`/nooks/${target}`);
						return;
					}

					const next = !nooksOpen();
					setNooksOpen(next);
				})();
				return;
			}
			void (async () => {
				if (nooks().length === 0) {
					await loadNooks();
				}
				const list = nooks();
				const preferred = String(
					window.localStorage.getItem(lastSelectedNookStorageKey) ?? "",
				).trim();
				const preferredExists =
					preferred !== "" && list.some((n) => n.id === preferred);
				const target = preferredExists
					? preferred
					: list[0]?.id
						? String(list[0].id)
						: "";
				if (target !== "") {
					navigate(`/nooks/${target}`);
					return;
				}

				const next = !nooksOpen();
				setNooksOpen(next);
			})();
			return;
		}
		const next = !nooksOpen();
		setNooksOpen(next);
		if (next && nooks().length === 0) {
			void loadNooks();
		}
	};

	const onSelectNook = (id: string) => {
		setNooksOpen(false);
		const target = id.trim();
		if (target === "") {
			navigate("/nooks");
			return;
		}
		window.localStorage.setItem(lastSelectedNookStorageKey, target);
		navigate(`/nooks/${target}`);
	};

	const onCreateNook = async () => {
		const name = newNookName().trim();
		if (!name) return;
		setNooksError("");
		try {
			const res = await apiFetch("/api/nooks", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name }, null, 0),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to create nook: ${res.status} ${res.statusText}`,
				);
			}
			const body = (await res.json()) as { nook?: unknown };
			const nookObj = (body?.nook ?? {}) as Record<string, unknown>;
			const id = typeof nookObj.id === "string" ? nookObj.id : "";
			if (id.trim() === "") {
				throw new Error("Create nook response missing id");
			}
			await loadNooks();
			setNewNookName("");
			setShowCreateNook(false);
			setNooksOpen(false);
			window.localStorage.setItem(lastSelectedNookStorageKey, id);
			navigate(`/nooks/${id}`);
		} catch (e) {
			setNooksError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			<nav class={styles.nav}>
				<div class={styles.links}>
					<span class={styles.hideOnMobile}>
						<A href="/" end activeClass="active">
							Home
						</A>
					</span>
					<span class={styles.hideOnMobile}>
						<A href="/about" activeClass="active">
							About
						</A>
					</span>
					{/* Mobile: home icon with dropdown for Home/About */}
					<span class={styles.showOnMobile}>
						<div class={styles.overflowMenuLeft}>
							<button
								type="button"
								class={styles.homeToggle}
								title="Navigation"
							>
								<svg
									aria-hidden="true"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
									<polyline points="9 22 9 12 15 12 15 22" />
								</svg>
							</button>
							<div class={styles.overflowContent}>
								<A href="/" end class={styles.overflowItem}>
									Home
								</A>
								<A href="/about" class={styles.overflowItem}>
									About
								</A>
							</div>
						</div>
					</span>
					<Show
						when={auth.ready() && auth.authenticated()}
						fallback={
							auth.ready() ? (
								<Button
									variant="primary"
									size="small"
									onClick={() => auth.login("/nooks")}
								>
									Log in
								</Button>
							) : (
								<div>Signing in…</div>
							)
						}
					>
						<div class={styles.dropdown}>
							<button
								type="button"
								class={styles["dropdown-toggle"]}
								onClick={() => toggleNooks()}
							>
								{currentNookLabel()}
							</button>
							<Show when={nooksOpen()}>
								{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes */}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes */}
								<div
									class={styles.dropdownBackdrop}
									onClick={() => setNooksOpen(false)}
								/>
								<div class={styles["dropdown-menu"]}>
									<div class={styles.dropdownCloseBar}>
										<span>{currentNookLabel()}</span>
										<button
											type="button"
											onClick={() => setNooksOpen(false)}
											style={{
												background: "none",
												border: "none",
												"font-size": "1.25rem",
												cursor: "pointer",
												padding: "0 4px",
												"line-height": "1",
											}}
										>
											&times;
										</button>
									</div>
									{/* Current nook */}
									<Show when={currentNookId().trim() !== ""}>
										<div class={styles.dropdownSection}>
											<div class={styles.dropdownCurrentNook}>
												{currentNookLabel()}
											</div>
											<button
												type="button"
												class={styles["dropdown-item"]}
												onClick={() => {
													setNooksOpen(false);
													navigate(
														`/nooks/${encodeURIComponent(currentNookId())}/settings`,
													);
												}}
											>
												Settings
											</button>
										</div>
									</Show>
									{/* Other nooks */}
									<Show when={nooksError().trim() !== ""}>
										<div class={styles["dropdown-error"]}>{nooksError()}</div>
									</Show>
									<Show when={!nooksLoading()} fallback={<div>Loading…</div>}>
										{(() => {
											const otherNooks = () =>
												nooks().filter((n) => n.id !== currentNookId());
											return (
												<div class={styles.dropdownSection}>
													<Show when={otherNooks().length > 0}>
														<div class={styles.dropdownSectionTitle}>
															Switch nook
														</div>
														<div class={styles["dropdown-list"]}>
															<For each={otherNooks()}>
																{(n) => (
																	<button
																		type="button"
																		class={styles["dropdown-item"]}
																		onClick={() => onSelectNook(n.id)}
																	>
																		<span>
																			{n.is_personal ? "My notes" : n.name}
																		</span>
																		<span class={styles["dropdown-meta"]}>
																			{n.role}
																		</span>
																	</button>
																)}
															</For>
														</div>
													</Show>
													<Show
														when={showCreateNook()}
														fallback={
															<div class={styles["dropdown-header"]}>
																<Button
																	variant="secondary"
																	size="small"
																	onClick={() => setShowCreateNook(true)}
																>
																	+ Create nook
																</Button>
															</div>
														}
													>
														<div class={styles.createNookForm}>
															<input
																type="text"
																value={newNookName()}
																onInput={(e) =>
																	setNewNookName(e.currentTarget.value)
																}
																onKeyDown={(e) => {
																	if (e.key === "Enter") void onCreateNook();
																	if (e.key === "Escape") {
																		setShowCreateNook(false);
																		setNewNookName("");
																	}
																}}
																placeholder="Nook name..."
																class={styles.createNookInput}
															/>
															<Button
																variant="primary"
																size="small"
																onClick={() => void onCreateNook()}
																disabled={newNookName().trim() === ""}
															>
																Create
															</Button>
															<Button
																variant="secondary"
																size="small"
																onClick={() => {
																	setShowCreateNook(false);
																	setNewNookName("");
																}}
															>
																Cancel
															</Button>
														</div>
													</Show>
												</div>
											);
										})()}
									</Show>
								</div>
							</Show>
						</div>
					</Show>
				</div>
				<Show when={auth.ready() && auth.authenticated()}>
					<div class={styles.dropdown}>
						<button type="button" class={styles.userToggle} title="Account">
							<svg
								aria-hidden="true"
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
								<circle cx="12" cy="7" r="4" />
							</svg>
							<span class={styles.userToggleName}>
								{userName() || "Account"}
							</span>
						</button>
						<div class={styles.userMenu}>
							<div class={styles.userMenuName}>{userName() || "Account"}</div>
							<button
								type="button"
								class={styles.overflowItem}
								onClick={() => auth.logout()}
							>
								Logout
							</button>
							<button
								type="button"
								class={styles.overflowItem}
								onClick={() => auth.logoutSso()}
							>
								Logout SSO
							</button>
						</div>
					</div>
				</Show>
			</nav>

			<Show when={currentNookId().trim() !== ""}>
				<div class={styles.nookBar}>
					<Show
						when={inNookSettings()}
						fallback={
							<>
								<div class={styles.nookBarGroup}>
									<NookNotesSearchDropdown store={store()} />
									<NookTypeFilterDropdown store={store()} />
								</div>
								<div class={styles.nookBarGroup}>
									<span class={styles.hideOnMobile}>
										<Button
											variant={isMarkdownPanel() ? "primary" : "secondary"}
											size="small"
											disabled={
												!storeReady() ||
												(store()?.selectedId().trim() ?? "") === ""
											}
											onClick={() =>
												ui.setActivePanel(
													isMarkdownPanel() ? "content" : "markdown",
												)
											}
											aria-pressed={isMarkdownPanel()}
											title={
												isMarkdownPanel() ? "Hide markdown" : "Show markdown"
											}
										>
											Markdown
										</Button>
									</span>
									<span class={styles.hideOnMobile}>
										<Button
											variant={ui.graphPanelOpen() ? "primary" : "secondary"}
											size="small"
											class={styles.iconButton}
											onClick={() => ui.toggleGraphPanel()}
											aria-pressed={ui.graphPanelOpen()}
											title={ui.graphPanelOpen() ? "Hide graph" : "Show graph"}
										>
											<svg
												aria-hidden="true"
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<circle cx="6" cy="6" r="2" />
												<circle cx="18" cy="6" r="2" />
												<circle cx="12" cy="18" r="2" />
												<path d="M8 7.5 L16 7.5" />
												<path d="M7 8.5 L11 16" />
												<path d="M17 8.5 L13 16" />
											</svg>
										</Button>
									</span>
									<span class={styles.hideOnMobile}>
										<Button
											variant={ui.chatPanelOpen() ? "primary" : "secondary"}
											size="small"
											onClick={() => ui.toggleChatPanel()}
											aria-pressed={ui.chatPanelOpen()}
											title={ui.chatPanelOpen() ? "Hide chat" : "Open AI chat"}
										>
											Chat
										</Button>
									</span>
									{/* Overflow menu — visible on mobile only */}
									<span class={styles.showOnMobile}>
										<div class={styles.overflowMenu}>
											<Button
												variant="secondary"
												size="small"
												title="Switch panel"
											>
												{
													{
														content: "Note",
														links: "Links",
														graph: "Graph",
														chat: "Chat",
														markdown: "MD",
													}[ui.activePanel()]
												}{" "}
												<span style={{ "font-size": "0.6rem", opacity: "0.6" }}>
													▾
												</span>
											</Button>
											<div class={styles.overflowContent}>
												{(
													[
														["content", "Note"],
														["links", "Links & Mentions"],
														["graph", "Graph"],
														["chat", "Chat"],
														["markdown", "Markdown Source"],
													] as const
												).map(([panel, label]) => (
													<button
														type="button"
														class={`${styles.overflowItem} ${ui.activePanel() === panel ? styles.overflowItemActive : ""}`}
														onClick={() => {
															if (panel === "graph") ui.setGraphPanelOpen(true);
															if (panel === "chat") ui.setChatPanelOpen(true);
															ui.setActivePanel(panel);
														}}
													>
														{label}
													</button>
												))}
											</div>
										</div>
									</span>
								</div>
							</>
						}
					>
						<div class={styles.nookBarGroup} />
						<div class={styles.nookBarGroup}>
							<Button
								variant="secondary"
								size="small"
								onClick={() => {
									const n = currentNookId().trim();
									if (n === "") return;
									navigate(`/nooks/${encodeURIComponent(n)}`);
								}}
							>
								Close settings
							</Button>
						</div>
					</Show>
				</div>
			</Show>
		</>
	);
}
