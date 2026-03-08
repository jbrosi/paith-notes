import { A, useLocation, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../auth/keycloak";
import { useUi } from "../ui/UiContext";
import { Button } from "./Button";
import styles from "./Nav.module.css";

type NookListItem = {
	id: string;
	name: string;
	role: string;
	is_personal: boolean;
};

export function Nav() {
	const auth = useAuth();
	const ui = useUi();
	const navigate = useNavigate();
	const location = useLocation();

	const [nooksOpen, setNooksOpen] = createSignal<boolean>(false);
	const [nooks, setNooks] = createSignal<NookListItem[]>([]);
	const [nooksLoading, setNooksLoading] = createSignal<boolean>(false);
	const [nooksError, setNooksError] = createSignal<string>("");

	const currentNookId = createMemo(() => {
		const m = location.pathname.match(/^\/nooks\/([^/]+)/);
		return m?.[1] ? String(m[1]) : "";
	});

	const currentNookLabel = createMemo(() => {
		const id = currentNookId();
		if (id === "") return "My notes";
		const found = nooks().find((n) => n.id === id);
		if (!found) return "Nooks";
		return found.is_personal ? "My notes" : found.name;
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
			navigate(`/nooks/${id}`);
		} catch (e) {
			setNooksError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
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
													<span class={styles["dropdown-meta"]}>{n.role}</span>
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
						onClick={() => ui.toggleMode()}
					>
						Mode: {ui.mode() === "edit" ? "Edit" : "View"}
					</Button>
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
	);
}
