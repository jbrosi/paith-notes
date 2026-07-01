import { createSignal, For, onMount, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import { useUi } from "../../ui/UiContext";
import { NookAiPolicySection } from "./NookAiPolicySection";
import styles from "./NookSettingsLanding.module.css";
import { NookSharingSection } from "./NookSharingSection";

export type NookSettingsLandingProps = {
	nookId: string;
	nookName: string;
	nookRole: string;
	/** Current value of the nook-wide AI policy ('approve_all' | 'auto_reads' | 'disabled'). */
	aiMode: string;
	onClose: () => void;
	onOpenLinks: () => void;
	onOpenTypes: () => void;
	onOpenActivity?: () => void;
	onOpenUnlinked?: () => void;
	onNameSaved?: (name: string) => void;
	/** Fires when the owner saves a new AI mode so parent can re-render. */
	onAiModeSaved?: (mode: string) => void;
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
const DEFAULT_ACCENT = "#3b82f6";
const AI_MEMORY_ACCENT = "#ec4899";

/** Set a default accent color for a nook if not already set. */
export function ensureNookAccentColor(
	nookId: string,
	isAiMemory = false,
): void {
	try {
		for (const mode of ["light", "dark"]) {
			const key = `${STORAGE_PREFIX}${nookId}:${mode}:accent`;
			if (!window.localStorage.getItem(key)) {
				window.localStorage.setItem(
					key,
					isAiMemory ? AI_MEMORY_ACCENT : DEFAULT_ACCENT,
				);
			}
		}
	} catch {
		// ignore
	}
}

/** Get the accent color for a nook (from localStorage). Returns null if not set. */
export function getNookAccentColor(nookId: string): string | null {
	try {
		const mode = currentMode();
		const v = window.localStorage.getItem(
			`${STORAGE_PREFIX}${nookId}:${mode}:accent`,
		);
		return v && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
	} catch {
		return null;
	}
}

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

		// Persist locally
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

		// Persist accent to backend (per user-nook preference)
		if (seedKey === "accent") {
			void (async () => {
				try {
					await apiFetch(
						`/api/nooks/${encodeURIComponent(props.nookId)}/preferences`,
						{
							method: "PUT",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								settings: { accent_color: value || null },
							}),
						},
					);
				} catch {
					// best-effort
				}
			})();
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
					<Button
						variant="secondary"
						size="small"
						onClick={props.onOpenActivity}
					>
						Activity
					</Button>
					<Button
						variant="secondary"
						size="small"
						onClick={props.onOpenUnlinked}
					>
						Unlinked notes
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

			{/* AI policy — extracted to its own component; renders the
			    owner-only radio group or a read-only chip for members. */}
			<NookAiPolicySection
				nookId={props.nookId}
				nookName={props.nookName}
				nookRole={props.nookRole}
				aiMode={props.aiMode}
				onAiModeSaved={props.onAiModeSaved}
			/>

			{/* Export section — owner only */}
			<Show when={isOwner()}>
				<div class={styles.section}>
					<div class={styles.sectionTitle}>Backup & Export</div>
					<p class={styles.hint}>
						Download a full backup of this nook as a ZIP archive. Notes are
						exported as readable Markdown files with frontmatter, organized by
						type hierarchy. A backup note is also stored in this nook for easy
						access later.
					</p>
					<ExportButton nookId={props.nookId} />
				</div>
			</Show>

			{/* Sharing section — owner only. Fully self-contained
			    (own state, own fetch on mount) — keeps this parent
			    file focused. */}
			<NookSharingSection nookId={props.nookId} nookRole={props.nookRole} />
		</div>
	);
}

function ExportButton(props: { nookId: string }) {
	const [exporting, setExporting] = createSignal(false);
	const [error, setError] = createSignal("");

	const doExport = async () => {
		setExporting(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/export`,
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(body?.error || `Export failed: ${res.status}`);
			}
			// Trigger download from the response blob
			const blob = await res.blob();
			const disposition = res.headers.get("Content-Disposition") ?? "";
			const filenameMatch = disposition.match(/filename="([^"]+)"/);
			const filename = filenameMatch ? filenameMatch[1] : "export.zip";

			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExporting(false);
		}
	};

	return (
		<div>
			<Button
				variant="secondary"
				size="small"
				onClick={() => void doExport()}
				disabled={exporting()}
			>
				{exporting() ? "Exporting..." : "Export nook"}
			</Button>
			<Show when={error()}>
				<div class={styles.sharingError}>{error()}</div>
			</Show>
		</div>
	);
}
