import { createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import styles from "./NookSettingsLanding.module.css";

/**
 * Owner-controlled, nook-wide AI access policy.
 *
 * Renders a radio group for the three policy tiers (approve_all,
 * auto_reads, disabled). Saves via PUT /api/nooks/{id} on every
 * change. Optimistic — rolls back the radio selection on save failure
 * and surfaces the error inline.
 *
 * For non-owner members, falls back to a read-only chip explaining the
 * current policy.
 */
type Props = {
	nookId: string;
	nookName: string;
	nookRole: string;
	aiMode: string;
	onAiModeSaved?: (mode: string) => void;
};

const MODES: ReadonlyArray<{ value: string; title: string; desc: string }> = [
	{
		value: "approve_all",
		title: "Allow AI, approve everything (default)",
		desc: "AI may use any tool but every action — reads, writes, deletes — requires explicit approval. Safest.",
	},
	{
		value: "auto_reads",
		title: "Allow AI, auto-approve reads",
		desc: "AI may read notes / search / browse without asking. Writes (create, edit, delete) still require approval. Saves clicks while keeping changes under review.",
	},
	{
		value: "disabled",
		title: "Do not allow AI",
		desc: "AI tool calls targeting this nook are blocked entirely. Cross-nook search also excludes this nook. The AI will see a clear policy error.",
	},
];

export function NookAiPolicySection(props: Props) {
	const isOwner = () => props.nookRole === "owner";

	const [aiModeLocal, setAiModeLocal] = createSignal(props.aiMode);
	const [aiModeSaving, setAiModeSaving] = createSignal(false);
	const [aiModeError, setAiModeError] = createSignal("");

	const saveAiMode = async (next: string) => {
		const prev = aiModeLocal();
		if (next === prev) return;
		setAiModeLocal(next);
		setAiModeSaving(true);
		setAiModeError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: props.nookName, ai_mode: next }),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body?.error || `Failed: ${res.status}`);
			}
			props.onAiModeSaved?.(next);
		} catch (e) {
			setAiModeLocal(prev);
			setAiModeError(e instanceof Error ? e.message : String(e));
		} finally {
			setAiModeSaving(false);
		}
	};

	const readonlyMessage = () => {
		switch (aiModeLocal()) {
			case "disabled":
				return "The nook owner has disabled AI access for this nook.";
			case "auto_reads":
				return "The nook owner allows AI to auto-approve reads in this nook (writes still require approval).";
			default:
				return "AI access requires explicit approval for every action (default).";
		}
	};

	return (
		<div class={styles.section}>
			<div class={styles.sectionTitle}>AI access</div>
			<Show
				when={isOwner()}
				fallback={
					<p class={styles.hint}>
						{readonlyMessage()} Only the owner can change this.
					</p>
				}
			>
				<p class={styles.hint}>
					Controls what the AI assistant can do in this nook.{" "}
					<strong>This is a nook-wide setting</strong> — your choice applies to
					every user who has access to this nook, not just you. Only the nook
					owner can change it.
				</p>

				<div role="radiogroup" aria-label="AI access mode">
					<For each={MODES}>
						{(opt) => (
							<label
								style={{
									display: "block",
									padding: "10px 12px",
									margin: "6px 0",
									border: "1px solid var(--color-border-medium)",
									"border-radius": "6px",
									cursor: aiModeSaving() ? "wait" : "pointer",
									background:
										aiModeLocal() === opt.value
											? "var(--color-bg-tertiary, transparent)"
											: "transparent",
								}}
							>
								<div
									style={{
										display: "flex",
										"align-items": "baseline",
										gap: "8px",
									}}
								>
									<input
										type="radio"
										name="ai_mode"
										value={opt.value}
										checked={aiModeLocal() === opt.value}
										disabled={aiModeSaving()}
										onChange={() => void saveAiMode(opt.value)}
									/>
									<strong>{opt.title}</strong>
								</div>
								<div
									style={{
										"margin-left": "24px",
										"margin-top": "2px",
										color: "var(--color-text-muted)",
										"font-size": "0.85em",
									}}
								>
									{opt.desc}
								</div>
							</label>
						)}
					</For>
				</div>

				<Show when={aiModeError() !== ""}>
					<p
						style={{
							color: "var(--color-danger)",
							"font-size": "0.85em",
							"margin-top": "6px",
						}}
					>
						{aiModeError()}
					</p>
				</Show>
			</Show>
		</div>
	);
}
