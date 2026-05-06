import { Show } from "solid-js";
import { Button } from "../../components/Button";
import styles from "./NookToolbar.module.css";

export type NookToolbarProps = {
	mode: "view" | "edit";
	loading: boolean;
	title: string;
	selectedId: string;
	canWrite: boolean;
	onSave: () => void;
	onDelete: () => void;
	onToggleMode: () => void;
};

export function NookToolbar(props: NookToolbarProps) {
	const isEditing = () => props.mode === "edit";

	return (
		<div class={styles.toolbar}>
			{/* Left side: Save (edit mode only) or read-only indicator */}
			<div class={styles.toolbarLeft}>
				<Show when={!props.canWrite}>
					<span class={styles.readonlyBadge}>Read-only</span>
				</Show>
				<Show when={isEditing() && props.canWrite}>
					<Button
						onClick={props.onSave}
						disabled={props.loading || props.title.trim() === ""}
					>
						Save
					</Button>
				</Show>
			</div>

			{/* Right side: edit toggle + delete/cancel (only when canWrite) */}
			<div class={styles.toolbarRight}>
				<Show when={props.canWrite}>
					<Show
						when={isEditing()}
						fallback={
							<Button
								variant="secondary"
								size="small"
								onClick={props.onToggleMode}
								title="Switch to edit mode"
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
									style={{
										"vertical-align": "middle",
										"margin-right": "4px",
									}}
								>
									<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
									<path d="m15 5 4 4" />
								</svg>
								Edit
							</Button>
						}
					>
						<Button
							onClick={props.onDelete}
							variant="danger"
							size="small"
							disabled={props.loading || props.selectedId === ""}
							title="Delete note"
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
								<path d="M3 6h18" />
								<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
								<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
							</svg>
						</Button>
						<Button
							variant="secondary"
							size="small"
							onClick={props.onToggleMode}
							title="Cancel editing"
						>
							Cancel
						</Button>
					</Show>
				</Show>
			</div>
		</div>
	);
}
