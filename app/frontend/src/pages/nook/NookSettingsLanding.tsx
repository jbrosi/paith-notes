import { createSignal, For, onMount, Show } from "solid-js";
import { Button } from "../../components/Button";
import { useUi } from "../../ui/UiContext";
import styles from "./NookSettingsLanding.module.css";

export type NookSettingsLandingProps = {
	nookId: string;
	onClose: () => void;
	onOpenLinks: () => void;
	onOpenTypes: () => void;
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

	return (
		<div class={styles.container}>
			<div class={styles.header}>Nook settings</div>

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
		</div>
	);
}
