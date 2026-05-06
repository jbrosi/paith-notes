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
	is_owned: boolean;
	owner_name: string;
};

type InvitationItem = {
	id: string;
	nook_id: string;
	nook_name: string;
	role: string;
	inviter_name: string;
	created_at: string;
};

type RevocationItem = {
	id: string;
	nook_name: string;
	revoked_by_name: string;
	created_at: string;
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
	const [invitations, setInvitations] = createSignal<InvitationItem[]>([]);
	const [revocations, setRevocations] = createSignal<RevocationItem[]>([]);
	const [fileInputRef, setFileInputRef] = createSignal<HTMLInputElement>();

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

	const nookDisplayName = (n: NookListItem) => n.name || "Unnamed nook";

	const currentNookLabel = createMemo(() => {
		const id = currentNookId();
		if (id === "") {
			const preferred = String(
				window.localStorage.getItem(lastSelectedNookStorageKey) ?? "",
			).trim();
			if (preferred !== "") {
				const foundPreferred = nooks().find((n) => n.id === preferred);
				if (foundPreferred) {
					return nookDisplayName(foundPreferred);
				}
			}
			return "Select nook";
		}
		const found = nooks().find((n) => n.id === id);
		if (!found) return "Nooks";
		return nookDisplayName(found);
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

	// Load pending invitations & revocation notices
	createEffect(() => {
		if (!auth.ready() || !auth.authenticated()) return;
		void loadNotices();
	});

	const loadNotices = async () => {
		try {
			const [invRes, revRes] = await Promise.all([
				apiFetch("/api/me/invitations", { method: "GET" }),
				apiFetch("/api/me/revocations", { method: "GET" }),
			]);
			if (invRes.ok) {
				const body = (await invRes.json()) as { invitations?: unknown };
				const list = Array.isArray(body?.invitations) ? body.invitations : [];
				setInvitations(
					list
						.filter(
							(i: unknown): i is Record<string, unknown> =>
								!!i && typeof i === "object",
						)
						.map((i) => ({
							id: String(i.id ?? ""),
							nook_id: String(i.nook_id ?? ""),
							nook_name: String(i.nook_name ?? ""),
							role: String(i.role ?? ""),
							inviter_name: String(i.inviter_name ?? ""),
							created_at: String(i.created_at ?? ""),
						})),
				);
			}
			if (revRes.ok) {
				const body = (await revRes.json()) as { revocations?: unknown };
				const list = Array.isArray(body?.revocations) ? body.revocations : [];
				setRevocations(
					list
						.filter(
							(r: unknown): r is Record<string, unknown> =>
								!!r && typeof r === "object",
						)
						.map((r) => ({
							id: String(r.id ?? ""),
							nook_name: String(r.nook_name ?? ""),
							revoked_by_name: String(r.revoked_by_name ?? ""),
							created_at: String(r.created_at ?? ""),
						})),
				);
			}
		} catch {
			// best-effort
		}
	};

	const acceptInvitation = async (invId: string) => {
		try {
			const res = await apiFetch(
				`/api/me/invitations/${encodeURIComponent(invId)}/accept`,
				{ method: "POST" },
			);
			if (res.ok) {
				await Promise.all([loadNooks(), loadNotices()]);
			}
		} catch {
			// best-effort
		}
	};

	const declineInvitation = async (invId: string) => {
		try {
			await apiFetch(
				`/api/me/invitations/${encodeURIComponent(invId)}/decline`,
				{ method: "POST" },
			);
			await loadNotices();
		} catch {
			// best-effort
		}
	};

	const dismissRevocation = async (revId: string) => {
		try {
			await apiFetch(
				`/api/me/revocations/${encodeURIComponent(revId)}/dismiss`,
				{ method: "POST" },
			);
			await loadNotices();
		} catch {
			// best-effort
		}
	};

	const noticeCount = createMemo(
		() => invitations().length + revocations().length,
	);

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
					is_owned: Boolean(obj.is_owned),
					owner_name: typeof obj.owner_name === "string" ? obj.owner_name : "",
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
		if (next) {
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
								<Show when={noticeCount() > 0}>
									<span class={styles.noticeBadge}>{noticeCount()}</span>
								</Show>
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
											<A
												href={`/nooks/${encodeURIComponent(currentNookId())}`}
												class={styles["dropdown-item"]}
												style={{
													"justify-content": "flex-start",
													gap: "6px",
													"text-decoration": "none",
													color: "inherit",
												}}
												onClick={() => {
													store()?.setSelectedId("");
													setNooksOpen(false);
												}}
											>
												<svg
													aria-hidden="true"
													width="14"
													height="14"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													style={{ "flex-shrink": "0" }}
												>
													<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
													<polyline points="9 22 9 12 15 12 15 22" />
												</svg>
												{currentNookLabel()}
											</A>
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
																		class={`${styles["dropdown-item"]}${!n.is_owned ? ` ${styles.sharedNookItem}` : ""}`}
																		onClick={() => onSelectNook(n.id)}
																	>
																		<span class={styles.dropdownItemContent}>
																			<span>{nookDisplayName(n)}</span>
																			<Show when={!n.is_owned && n.owner_name}>
																				<span class={styles.sharedByLabel}>
																					Shared by {n.owner_name}
																				</span>
																			</Show>
																		</span>
																		<span class={styles["dropdown-meta"]}>
																			{n.role === "readonly"
																				? "read-only"
																				: n.role === "readwrite"
																					? "read-write"
																					: n.role}
																		</span>
																	</button>
																)}
															</For>
														</div>
													</Show>
													{/* Invitations & revocation notices */}
													<Show when={invitations().length > 0}>
														<div class={styles.dropdownSectionTitle}>
															Pending invitations
														</div>
														<For each={invitations()}>
															{(inv) => (
																<div class={styles.noticeItem}>
																	<div class={styles.noticeText}>
																		<strong>{inv.nook_name}</strong>
																		<span class={styles.sharedByLabel}>
																			from {inv.inviter_name} (
																			{inv.role === "readonly"
																				? "read-only"
																				: "read-write"}
																			)
																		</span>
																	</div>
																	<div class={styles.noticeActions}>
																		<Button
																			variant="primary"
																			size="small"
																			onClick={() =>
																				void acceptInvitation(inv.id)
																			}
																		>
																			Accept
																		</Button>
																		<Button
																			variant="secondary"
																			size="small"
																			onClick={() =>
																				void declineInvitation(inv.id)
																			}
																		>
																			Decline
																		</Button>
																	</div>
																</div>
															)}
														</For>
													</Show>
													<Show when={revocations().length > 0}>
														<div class={styles.dropdownSectionTitle}>
															Notices
														</div>
														<For each={revocations()}>
															{(rev) => (
																<div class={styles.noticeItem}>
																	<div class={styles.noticeText}>
																		Access to <strong>{rev.nook_name}</strong>{" "}
																		was revoked
																		{rev.revoked_by_name
																			? ` by ${rev.revoked_by_name}`
																			: ""}
																	</div>
																	<div class={styles.noticeActions}>
																		<Button
																			variant="secondary"
																			size="small"
																			onClick={() =>
																				void dismissRevocation(rev.id)
																			}
																		>
																			Dismiss
																		</Button>
																	</div>
																</div>
															)}
														</For>
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
								onClick={() => ui.cycleTheme()}
							>
								Theme:{" "}
								{ui.theme() === "system"
									? "Auto"
									: ui.theme() === "dark"
										? "Dark"
										: "Light"}
							</button>
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

			<Show
				when={
					currentNookId().trim() !== "" &&
					(inNookSettings() ||
						(store()?.selectedId() ?? "") !== "" ||
						store()?.mode() === "edit")
				}
			>
				<div class={styles.nookBar}>
					<Show
						when={inNookSettings()}
						fallback={
							<>
								<div class={styles.nookBarGroup}>
									<Show when={store()?.canWrite()}>
										<Button
											variant="secondary"
											size="small"
											onClick={() => {
												store()?.newNote();
												ui.setMode("edit");
											}}
											title="New note"
										>
											<svg
												aria-hidden="true"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												stroke-linecap="round"
												stroke-linejoin="round"
												style={{ "vertical-align": "middle" }}
											>
												<path d="M12 5v14" />
												<path d="M5 12h14" />
											</svg>
										</Button>
										<input
											ref={setFileInputRef}
											type="file"
											style={{ display: "none" }}
											onChange={(e) => {
												const f = e.currentTarget.files?.[0];
												if (f) void store()?.quickUploadFile(f);
												e.currentTarget.value = "";
											}}
										/>
										<Button
											variant="secondary"
											size="small"
											onClick={() => fileInputRef()?.click()}
											title="Upload file"
										>
											<svg
												aria-hidden="true"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												style={{ "vertical-align": "middle" }}
											>
												<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
												<polyline points="17 8 12 3 7 8" />
												<line x1="12" y1="3" x2="12" y2="15" />
											</svg>
										</Button>
									</Show>
									<NookNotesSearchDropdown
										store={store()}
										onNewNote={() => {
											store()?.newNote();
											ui.setMode("edit");
										}}
										onUploadFile={() => fileInputRef()?.click()}
									/>
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
