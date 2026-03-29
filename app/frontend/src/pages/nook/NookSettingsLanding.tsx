import { For, Show } from "solid-js";
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

export function NookSettingsLanding(props: NookSettingsLandingProps) {
	const ui = useUi();

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
		</div>
	);
}
