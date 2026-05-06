import { createSignal, For, onMount, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import { useUi } from "../../ui/UiContext";
import styles from "./NookSettingsLanding.module.css";

export type NookSettingsLandingProps = {
	nookId: string;
	nookName: string;
	nookRole: string;
	onClose: () => void;
	onOpenLinks: () => void;
	onOpenTypes: () => void;
	onNameSaved?: (name: string) => void;
};

type MemberItem = {
	id: string;
	name: string;
	email: string;
	role: string;
	joined_at: string;
};

type InvitationItem = {
	id: string;
	invited_email: string;
	role: string;
	status: string;
	inviter_name: string;
	created_at: string;
};

const PRESET_ACCENTS = [
	{ color: "#3b82f6", label: "Blue" },
	{ color: "#8b5cf6", label: "Purple" },
	{ color: "#ec4899", label: "Pink" },
	{ color: "#ef4444", label: "Red" },
	{ color: "#f97316", label: "Orange" },
	{ color: "#eab308", label: "Yellow" },
	{ color: "#22c55e", label: "Green" },
	{ color: "#14b8a6", label: "Teal" },
	{ color: "#06b6d4", label: "Cyan" },
	{ color: "#6366f1", label: "Indigo" },
];

type SeedDef = {
	key: string;
	cssVar: string;
	label: string;
	defaultLight: string;
	defaultDark: string;
};

const SEEDS: SeedDef[] = [
	{
		key: "accent",
		cssVar: "--seed-accent",
		label: "Accent",
		defaultLight: "#3b82f6",
		defaultDark: "#6baaff",
	},
	{
		key: "bg",
		cssVar: "--seed-bg",
		label: "Background",
		defaultLight: "#ffffff",
		defaultDark: "#1a1d2e",
	},
	{
		key: "text",
		cssVar: "--seed-text",
		label: "Text",
		defaultLight: "#111827",
		defaultDark: "#e2e6f0",
	},
	{
		key: "surface",
		cssVar: "--seed-surface",
		label: "Surface",
		defaultLight: "#f8fafc",
		defaultDark: "#1f2337",
	},
	{
		key: "muted",
		cssVar: "--seed-muted",
		label: "Muted",
		defaultLight: "#64748b",
		defaultDark: "#8990a4",
	},
	{
		key: "danger",
		cssVar: "--seed-danger",
		label: "Danger",
		defaultLight: "#dc2626",
		defaultDark: "#f85149",
	},
	{
		key: "warning",
		cssVar: "--seed-warning",
		label: "Warning",
		defaultLight: "#d97706",
		defaultDark: "#e3b341",
	},
	{
		key: "success",
		cssVar: "--seed-success",
		label: "Success",
		defaultLight: "#16a34a",
		defaultDark: "#4ade80",
	},
	{
		key: "info",
		cssVar: "--seed-info",
		label: "Info",
		defaultLight: "#0891b2",
		defaultDark: "#22d3ee",
	},
];

const STORAGE_PREFIX = "paith-notes:seed:";

function storageKey(nookId: string, mode: string, key: string) {
	return `${STORAGE_PREFIX}${nookId}:${mode}:${key}`;
}

function loadOverrides(nookId: string, mode: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const s of SEEDS) {
		try {
			const v = window.localStorage.getItem(storageKey(nookId, mode, s.key));
			if (v && /^#[0-9a-f]{6}$/i.test(v)) result[s.key] = v;
		} catch {
			// ignore
		}
	}
	return result;
}

function applyOverrides(overrides: Record<string, string>) {
	for (const s of SEEDS) {
		const val = overrides[s.key];
		if (val) {
			document.documentElement.style.setProperty(s.cssVar, val);
		} else {
			document.documentElement.style.removeProperty(s.cssVar);
		}
	}
}

function currentMode(): "light" | "dark" {
	return document.documentElement.getAttribute("data-theme") === "dark" ||
		(document.documentElement.getAttribute("data-theme") !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches)
		? "dark"
		: "light";
}

/** Called when navigating to a nook — applies stored seed overrides for current mode */
export function applyNookSeeds(nookId: string) {
	const mode = currentMode();
	const overrides = loadOverrides(nookId, mode);
	applyOverrides(overrides);
}

export function NookSettingsLanding(props: NookSettingsLandingProps) {
	const ui = useUi();
	const [nookNameInput, setNookNameInput] = createSignal(props.nookName);
	const [nameEditing, setNameEditing] = createSignal(false);
	const [nameSaving, setNameSaving] = createSignal(false);
	const [nameError, setNameError] = createSignal("");
	let nameInputRef: HTMLInputElement | undefined;

	const startEditing = () => {
		setNookNameInput(props.nookName);
		setNameEditing(true);
		setNameError("");
		requestAnimationFrame(() => {
			nameInputRef?.focus();
			nameInputRef?.select();
		});
	};

	const saveNookName = async () => {
		const name = nookNameInput().trim();
		if (name === "" || name === props.nookName) {
			setNameEditing(false);
			return;
		}
		setNameSaving(true);
		setNameError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name }),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(body?.error || `Failed: ${res.status}`);
			}
			props.onNameSaved?.(name);
			setNameEditing(false);
		} catch (e) {
			setNameError(e instanceof Error ? e.message : String(e));
		} finally {
			setNameSaving(false);
		}
	};

	const [showAdvanced, setShowAdvanced] = createSignal(false);
	const [lightOverrides, setLightOverrides] = createSignal<
		Record<string, string>
	>({});
	const [darkOverrides, setDarkOverrides] = createSignal<
		Record<string, string>
	>({});

	const mode = () => currentMode();
	const activeOverrides = () =>
		mode() === "dark" ? darkOverrides() : lightOverrides();

	onMount(() => {
		setLightOverrides(loadOverrides(props.nookId, "light"));
		setDarkOverrides(loadOverrides(props.nookId, "dark"));
		if (isOwner()) void loadSharing();
	});

	const setOverride = (seedKey: string, value: string) => {
		const m = mode();
		const setter = m === "dark" ? setDarkOverrides : setLightOverrides;
		const current = m === "dark" ? darkOverrides() : lightOverrides();
		const next = { ...current };
		if (value) {
			next[seedKey] = value;
		} else {
			delete next[seedKey];
		}
		setter(next);

		// Apply
		const seed = SEEDS.find((s) => s.key === seedKey);
		if (seed) {
			if (value) {
				document.documentElement.style.setProperty(seed.cssVar, value);
			} else {
				document.documentElement.style.removeProperty(seed.cssVar);
			}
		}

		// Persist
		try {
			const key = storageKey(props.nookId, m, seedKey);
			if (value) {
				window.localStorage.setItem(key, value);
			} else {
				window.localStorage.removeItem(key);
			}
		} catch {
			// ignore
		}
	};

	const setAccent = (color: string) => {
		setOverride("accent", color);
		// Also update UiContext so the accent signal reflects it
		ui.setAccentColor(color, props.nookId);
	};

	const resetAll = () => {
		const m = mode();
		for (const s of SEEDS) {
			setOverride(s.key, "");
		}
		if (m === "dark") {
			setDarkOverrides({});
		} else {
			setLightOverrides({});
		}
		ui.resetAccentColor(props.nookId);
	};

	const hasOverrides = () => Object.keys(activeOverrides()).length > 0;
	const advancedSeeds = () => SEEDS.filter((s) => s.key !== "accent");

	// ── Sharing ──
	const isOwner = () => props.nookRole === "owner";
	const [members, setMembers] = createSignal<MemberItem[]>([]);
	const [nookInvitations, setNookInvitations] = createSignal<InvitationItem[]>(
		[],
	);
	const [inviteEmail, setInviteEmail] = createSignal("");
	const [inviteRole, setInviteRole] = createSignal<"readonly" | "readwrite">(
		"readonly",
	);
	const [sharingError, setSharingError] = createSignal("");

	const loadSharing = async () => {
		if (!isOwner()) return;
		try {
			const [mRes, iRes] = await Promise.all([
				apiFetch(`/api/nooks/${encodeURIComponent(props.nookId)}/members`, {
					method: "GET",
				}),
				apiFetch(`/api/nooks/${encodeURIComponent(props.nookId)}/invitations`, {
					method: "GET",
				}),
			]);
			if (mRes.ok) {
				const body = (await mRes.json()) as { members?: unknown };
				const list = Array.isArray(body?.members) ? body.members : [];
				setMembers(
					list
						.filter(
							(m: unknown): m is Record<string, unknown> =>
								!!m && typeof m === "object",
						)
						.map((m) => ({
							id: String(m.id ?? ""),
							name: String(m.name ?? ""),
							email: String(m.email ?? ""),
							role: String(m.role ?? ""),
							joined_at: String(m.joined_at ?? ""),
						})),
				);
			}
			if (iRes.ok) {
				const body = (await iRes.json()) as { invitations?: unknown };
				const list = Array.isArray(body?.invitations) ? body.invitations : [];
				setNookInvitations(
					list
						.filter(
							(i: unknown): i is Record<string, unknown> =>
								!!i && typeof i === "object",
						)
						.map((i) => ({
							id: String(i.id ?? ""),
							invited_email: String(i.invited_email ?? ""),
							role: String(i.role ?? ""),
							status: String(i.status ?? ""),
							inviter_name: String(i.inviter_name ?? ""),
							created_at: String(i.created_at ?? ""),
						})),
				);
			}
		} catch {
			// best-effort
		}
	};

	const sendInvite = async () => {
		const email = inviteEmail().trim();
		if (!email) return;
		setSharingError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/invitations`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, role: inviteRole() }),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body?.error || `Failed: ${res.status}`);
			}
			setInviteEmail("");
			await loadSharing();
		} catch (e) {
			setSharingError(e instanceof Error ? e.message : String(e));
		}
	};

	const revokeInvitation = async (invId: string) => {
		try {
			await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/invitations/${encodeURIComponent(invId)}`,
				{ method: "DELETE" },
			);
			await loadSharing();
		} catch {
			// best-effort
		}
	};

	const revokeMember = async (userId: string) => {
		try {
			await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/members/${encodeURIComponent(userId)}`,
				{ method: "DELETE" },
			);
			await loadSharing();
		} catch {
			// best-effort
		}
	};

	return (
		<div class={styles.container}>
			<div class={styles.nookHeader}>
				<Show
					when={nameEditing()}
					fallback={
						<>
							<h1 class={styles.nookTitle}>
								{props.nookName || "Unnamed nook"}
							</h1>
							<Show when={isOwner()}>
								<button
									type="button"
									class={styles.editNameBtn}
									onClick={startEditing}
									title="Rename nook"
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
										<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
										<path d="m15 5 4 4" />
									</svg>
								</button>
							</Show>
						</>
					}
				>
					<input
						ref={nameInputRef}
						type="text"
						value={nookNameInput()}
						onInput={(e) => setNookNameInput(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void saveNookName();
							if (e.key === "Escape") setNameEditing(false);
						}}
						class={styles.nookTitleInput}
					/>
					<Button
						variant="primary"
						size="small"
						onClick={() => void saveNookName()}
						disabled={nookNameInput().trim() === "" || nameSaving()}
					>
						{nameSaving() ? "Saving..." : "Save"}
					</Button>
				</Show>
			</div>
			<Show when={nameError().trim() !== ""}>
				<div class={styles.sharingError}>{nameError()}</div>
			</Show>

			<div class={styles.header}>Settings</div>
			<p class={styles.settingsNote}>
				Visual settings apply to this nook only and are stored in your browser.
			</p>

			<div class={styles.section}>
				<div class={styles.sectionTitle}>Navigation</div>
				<div class={styles.row}>
					<Button variant="secondary" size="small" onClick={props.onOpenLinks}>
						Links settings
					</Button>
					<Button variant="secondary" size="small" onClick={props.onOpenTypes}>
						Types settings
					</Button>
				</div>
			</div>

			<div class={styles.section}>
				<div class={styles.sectionTitle}>
					Accent color
					<span class={styles.modeTag}>{mode()}</span>
				</div>
				<p class={styles.hint}>
					Pick an accent for {mode()} mode. Switch theme to set the other.
				</p>
				<div class={styles.presets}>
					<For each={PRESET_ACCENTS}>
						{(preset) => (
							<button
								type="button"
								class={`${styles.presetSwatch} ${activeOverrides().accent === preset.color ? styles.presetActive : ""}`}
								style={{ background: preset.color }}
								onClick={() => setAccent(preset.color)}
								title={preset.label}
							/>
						)}
					</For>
				</div>
				<div class={styles.customRow}>
					<label class={styles.customLabel}>
						Custom
						<input
							type="color"
							value={
								activeOverrides().accent ||
								(mode() === "dark" ? "#6baaff" : "#3b82f6")
							}
							onInput={(e) => setAccent(e.currentTarget.value)}
							class={styles.customPicker}
						/>
					</label>
					<Show when={activeOverrides().accent}>
						<button
							type="button"
							class={styles.resetBtn}
							onClick={() => setAccent("")}
						>
							Reset
						</button>
					</Show>
				</div>
			</div>

			<div class={styles.section}>
				<button
					type="button"
					class={styles.advancedToggle}
					onClick={() => setShowAdvanced((v) => !v)}
				>
					{showAdvanced() ? "Hide" : "Show"} advanced overrides
					<span class={styles.advancedArrow}>{showAdvanced() ? "▴" : "▾"}</span>
					<span class={styles.modeTag}>{mode()}</span>
				</button>
				<Show when={showAdvanced()}>
					<p class={styles.hint}>
						Override seed colors for {mode()} mode. Switch theme to customize
						the other.
					</p>
					<div class={styles.seedGrid}>
						<For each={advancedSeeds()}>
							{(seed) => {
								const defaultVal = () =>
									mode() === "dark" ? seed.defaultDark : seed.defaultLight;
								return (
									<label class={styles.seedRow}>
										<span class={styles.seedLabel}>{seed.label}</span>
										<input
											type="color"
											value={activeOverrides()[seed.key] || defaultVal()}
											onInput={(e) =>
												setOverride(seed.key, e.currentTarget.value)
											}
											class={styles.customPicker}
										/>
										<Show when={activeOverrides()[seed.key]}>
											<button
												type="button"
												class={styles.resetBtn}
												onClick={() => setOverride(seed.key, "")}
											>
												Reset
											</button>
										</Show>
									</label>
								);
							}}
						</For>
					</div>
					<Show when={hasOverrides()}>
						<button type="button" class={styles.resetBtn} onClick={resetAll}>
							Reset all ({mode()})
						</button>
					</Show>
				</Show>
			</div>

			{/* Sharing section — owner only */}
			<Show when={isOwner()}>
				<div class={styles.section}>
					<div class={styles.sectionTitle}>Sharing</div>

					{/* Invite form */}
					<div class={styles.inviteForm}>
						<input
							type="email"
							placeholder="Email address..."
							value={inviteEmail()}
							onInput={(e) => setInviteEmail(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void sendInvite();
							}}
							class={styles.inviteInput}
						/>
						<select
							value={inviteRole()}
							onChange={(e) =>
								setInviteRole(e.currentTarget.value as "readonly" | "readwrite")
							}
							class={styles.inviteSelect}
						>
							<option value="readonly">Read-only</option>
							<option value="readwrite">Read-write</option>
						</select>
						<Button
							variant="primary"
							size="small"
							onClick={() => void sendInvite()}
							disabled={inviteEmail().trim() === ""}
						>
							Invite
						</Button>
					</div>
					<Show when={sharingError().trim() !== ""}>
						<div class={styles.sharingError}>{sharingError()}</div>
					</Show>

					{/* Pending invitations */}
					<Show
						when={
							nookInvitations().filter((i) => i.status === "pending").length > 0
						}
					>
						<div class={styles.sharingSubtitle}>Pending invitations</div>
						<For each={nookInvitations().filter((i) => i.status === "pending")}>
							{(inv) => (
								<div class={styles.sharingRow}>
									<span class={styles.sharingEmail}>{inv.invited_email}</span>
									<span class={styles.sharingRole}>
										{inv.role === "readonly" ? "read-only" : "read-write"}
									</span>
									<Button
										variant="secondary"
										size="small"
										onClick={() => void revokeInvitation(inv.id)}
									>
										Revoke
									</Button>
								</div>
							)}
						</For>
					</Show>

					{/* Current members */}
					<Show when={members().length > 0}>
						<div class={styles.sharingSubtitle}>Members</div>
						<For each={members()}>
							{(m) => (
								<div class={styles.sharingRow}>
									<span class={styles.sharingEmail}>
										{m.name || m.email}
										<Show when={m.name && m.email}>
											<span class={styles.sharingEmailSub}> ({m.email})</span>
										</Show>
									</span>
									<span class={styles.sharingRole}>{m.role}</span>
									<Show when={m.role !== "owner"}>
										<Button
											variant="secondary"
											size="small"
											onClick={() => void revokeMember(m.id)}
										>
											Revoke access
										</Button>
									</Show>
								</div>
							)}
						</For>
					</Show>
				</div>
			</Show>
		</div>
	);
}
