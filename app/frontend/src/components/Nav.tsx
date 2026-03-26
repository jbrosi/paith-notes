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

	const currentNookId = createMemo(() => {
		const m = location.pathname.match(/^\/nooks\/([^/]+)/);
		return m?.[1] ? String(m[1]) : "";
	});

	const inNookSettings = createMemo(() =>
		/^\/nooks\/[^/]+\/settings(\/|$)/.test(location.pathname),
	);

	const inNookMarkdown = createMemo(() =>
		/^\/nooks\/[^/]+\/notes\/[^/]+\/markdown$/u.test(location.pathname),
	);

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
		const name = window.prompt("Nook name");
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
					<A href="/" end activeClass="active">
						Home
					</A>
					<A href="/about" activeClass="active">
						About
					</A>
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
								Nooks: {currentNookLabel()}
							</button>
							<Show when={currentNookId().trim() !== ""}>
								<Button
									variant="secondary"
									size="small"
									class={styles.iconButton}
									onClick={() => {
										const n = currentNookId().trim();
										if (n === "") return;
										navigate(`/nooks/${encodeURIComponent(n)}/settings`);
									}}
									title="Nook settings"
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
										<circle cx="12" cy="12" r="3" />
										<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-1.41 3.41h-.12a2 2 0 0 1-1.41-.59l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 0 1-4 0v-.12a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 0 1 3.6 20.3a2 2 0 0 1 0-2.82l.06-.06A1.65 1.65 0 0 0 4 15.6a1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.12a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 4.7 3.6a2 2 0 0 1 2.82 0l.06.06A1.65 1.65 0 0 0 9.4 4a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.12a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 0 1 20.4 4.7a2 2 0 0 1 0 2.82l-.06.06A1.65 1.65 0 0 0 20 9.4a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.12a1.65 1.65 0 0 0-1.48 1z" />
									</svg>
								</Button>
							</Show>
							<Show when={nooksOpen()}>
								<div class={styles["dropdown-menu"]}>
									<div class={styles["dropdown-header"]}>
										<Button
											variant="secondary"
											size="small"
											onClick={() => void loadNooks()}
											disabled={nooksLoading()}
										>
											Refresh
										</Button>
										<Button
											variant="primary"
											size="small"
											onClick={() => void onCreateNook()}
										>
											Create nook
										</Button>
									</div>
									<Show when={nooksError().trim() !== ""}>
										<div class={styles["dropdown-error"]}>{nooksError()}</div>
									</Show>
									<Show when={!nooksLoading()} fallback={<div>Loading…</div>}>
										<div class={styles["dropdown-list"]}>
											<For each={nooks()}>
												{(n) => (
													<button
														type="button"
														class={styles["dropdown-item"]}
														onClick={() => onSelectNook(n.id)}
													>
														<span>{n.is_personal ? "My notes" : n.name}</span>
														<span class={styles["dropdown-meta"]}>
															{n.role}
														</span>
													</button>
												)}
											</For>
										</div>
									</Show>
								</div>
							</Show>
						</div>
					</Show>
				</div>
				<Show when={auth.ready() && auth.authenticated()}>
					<div class={styles.actions}>
						<Button
							variant="secondary"
							size="small"
							onClick={() => auth.logout()}
						>
							Logout
						</Button>
						<Button
							variant="secondary"
							size="small"
							onClick={() => auth.logoutSso()}
						>
							Logout SSO
						</Button>
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
									<Button
										variant="secondary"
										size="small"
										disabled={!storeReady()}
										onClick={() => store()?.newNote()}
										title="Create a new note"
									>
										New
									</Button>
									<NookTypeFilterDropdown store={store()} />
									<NookNotesSearchDropdown store={store()} />
								</div>
								<div class={styles.nookBarGroup}>
									<Button
										variant="secondary"
										size="small"
										onClick={() => ui.toggleMode()}
										title="Toggle edit/view mode"
									>
										Mode: {ui.mode() === "edit" ? "Edit" : "View"}
									</Button>
									<Button
										variant={inNookMarkdown() ? "primary" : "secondary"}
										size="small"
										disabled={
											!storeReady() ||
											(store()?.selectedId().trim() ?? "") === ""
										}
										onClick={() => {
											const s = store();
											if (!s) return;
											const n = currentNookId().trim();
											const id = s.selectedId().trim();
											if (n === "" || id === "") return;
											if (inNookMarkdown()) {
												navigate(
													`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(id)}`,
												);
												return;
											}
											navigate(
												`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(id)}/markdown`,
											);
										}}
										aria-pressed={inNookMarkdown()}
										title={inNookMarkdown() ? "Hide markdown" : "Show markdown"}
									>
										Markdown
									</Button>
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
									<Button
										variant={ui.chatPanelOpen() ? "primary" : "secondary"}
										size="small"
										onClick={() => ui.toggleChatPanel()}
										aria-pressed={ui.chatPanelOpen()}
										title={ui.chatPanelOpen() ? "Hide chat" : "Open AI chat"}
									>
										Chat
									</Button>
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
