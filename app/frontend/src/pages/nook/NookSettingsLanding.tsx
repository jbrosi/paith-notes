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

type SeedOverride = {
	key: string;
	cssVar: string;
	label: string;
	defaultLight: string;
	defaultDark: string;
};

const SEED_OVERRIDES: SeedOverride[] = [
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

function seedStorageKey(nookId: string, key: string) {
	return `${STORAGE_PREFIX}${nookId}:${key}`;
}

function loadSeedOverrides(nookId: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const s of SEED_OVERRIDES) {
		try {
			const v = window.localStorage.getItem(seedStorageKey(nookId, s.key));
			if (v && /^#[0-9a-f]{6}$/i.test(v)) result[s.key] = v;
		} catch {
			// ignore
		}
	}
	return result;
}

function applySeedOverride(key: string, value: string) {
	const seed = SEED_OVERRIDES.find((s) => s.key === key);
	if (!seed) return;
	if (value) {
		document.documentElement.style.setProperty(seed.cssVar, value);
	} else {
		document.documentElement.style.removeProperty(seed.cssVar);
	}
}

/** Called when navigating to a nook — applies all stored seed overrides */
export function applyNookSeeds(nookId: string) {
	const overrides = loadSeedOverrides(nookId);
	for (const s of SEED_OVERRIDES) {
		applySeedOverride(s.key, overrides[s.key] ?? "");
	}
}

export function NookSettingsLanding(props: NookSettingsLandingProps) {
	const ui = useUi();
	const [showAdvanced, setShowAdvanced] = createSignal(false);
	const [overrides, setOverrides] = createSignal<Record<string, string>>({});

	onMount(() => {
		setOverrides(loadSeedOverrides(props.nookId));
	});

	const setSeedOverride = (key: string, value: string) => {
		const next = { ...overrides(), [key]: value };
		if (!value) delete next[key];
		setOverrides(next);
		applySeedOverride(key, value);
		try {
			const storageKey = seedStorageKey(props.nookId, key);
			if (value) {
				window.localStorage.setItem(storageKey, value);
			} else {
				window.localStorage.removeItem(storageKey);
			}
		} catch {
			// ignore
		}
	};

	const resetAllSeeds = () => {
		for (const s of SEED_OVERRIDES) {
			setSeedOverride(s.key, "");
		}
	};

	const isDark = () =>
		document.documentElement.getAttribute("data-theme") === "dark" ||
		(document.documentElement.getAttribute("data-theme") !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);

	const hasOverrides = () => Object.keys(overrides()).length > 0;

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
				<div class={styles.sectionTitle}>Accent color</div>
				<p class={styles.hint}>
					Choose an accent color for this nook. All UI colors are derived from
					it.
				</p>
				<div class={styles.presets}>
					<For each={PRESET_ACCENTS}>
						{(preset) => (
							<button
								type="button"
								class={`${styles.presetSwatch} ${ui.accentColor() === preset.color ? styles.presetActive : ""}`}
								style={{ background: preset.color }}
								onClick={() => ui.setAccentColor(preset.color, props.nookId)}
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
							value={ui.accentColor() || "#3b82f6"}
							onInput={(e) =>
								ui.setAccentColor(e.currentTarget.value, props.nookId)
							}
							class={styles.customPicker}
						/>
					</label>
					<Show when={ui.accentColor() !== ""}>
						<button
							type="button"
							class={styles.resetBtn}
							onClick={() => ui.resetAccentColor(props.nookId)}
						>
							Reset to default
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
					{showAdvanced() ? "Hide" : "Show"} advanced color overrides
					<span class={styles.advancedArrow}>{showAdvanced() ? "▴" : "▾"}</span>
				</button>
				<Show when={showAdvanced()}>
					<p class={styles.hint}>
						Override individual seed colors. By default these derive from your
						accent + theme. Changes apply instantly.
					</p>
					<div class={styles.seedGrid}>
						<For each={SEED_OVERRIDES}>
							{(seed) => {
								const defaultVal = () =>
									isDark() ? seed.defaultDark : seed.defaultLight;
								return (
									<label class={styles.seedRow}>
										<span class={styles.seedLabel}>{seed.label}</span>
										<input
											type="color"
											value={overrides()[seed.key] || defaultVal()}
											onInput={(e) =>
												setSeedOverride(seed.key, e.currentTarget.value)
											}
											class={styles.customPicker}
										/>
										<Show when={overrides()[seed.key]}>
											<button
												type="button"
												class={styles.resetBtn}
												onClick={() => setSeedOverride(seed.key, "")}
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
						<button
							type="button"
							class={styles.resetBtn}
							onClick={resetAllSeeds}
						>
							Reset all overrides
						</button>
					</Show>
				</Show>
			</div>
		</div>
	);
}
