import { For } from "solid-js";
import { Button } from "../Button";
import type { ToolUse } from "./ChatMessage";
import styles from "./ToolApproval.module.css";

const DESTRUCTIVE_TOOLS = new Set(["delete_note"]);
const WRITE_TOOLS = new Set([
	"create_note",
	"update_note",
	"create_note_link",
	"open_note",
]);

function toolKind(name: string): "destructive" | "write" | "read" {
	if (DESTRUCTIVE_TOOLS.has(name)) return "destructive";
	if (WRITE_TOOLS.has(name)) return "write";
	return "read";
}

type DisplayName = { label: string; url?: string };

type Props = {
	tools: ToolUse[];
	displayNames: Record<string, DisplayName>;
	onApprove: () => void;
	onDeny: () => void;
	disabled: boolean;
};

function InputValue(props: {
	value: unknown;
	displayNames: Record<string, DisplayName>;
}) {
	const str = String(props.value ?? "");
	const resolved = () => props.displayNames[str];
	return (
		<span class={styles.inputVal}>
			{resolved() ? (
				resolved()?.url ? (
					<a
						href={resolved()?.url}
						class={styles.noteLink}
						target="_blank"
						rel="noreferrer"
					>
						{resolved()?.label}
					</a>
				) : (
					<span class={styles.resolvedLabel}>{resolved()?.label}</span>
				)
			) : (
				str
			)}
		</span>
	);
}

export function ToolApproval(props: Props) {
	const hasDestructive = () =>
		props.tools.some((t) => toolKind(t.name) === "destructive");

	return (
		<div class={styles.container}>
			<p class={styles.title}>Claude wants to use tools:</p>
			<For each={props.tools}>
				{(t) => {
					const kind = toolKind(t.name);
					return (
						<div
							class={`${styles.toolItem} ${kind === "destructive" ? styles.destructive : kind === "write" ? styles.write : ""}`}
						>
							<div class={styles.toolName}>
								{t.name}
								{kind === "destructive" && (
									<span class={`${styles.badge} ${styles.badgeDestructive}`}>
										irreversible
									</span>
								)}
								{kind === "write" && (
									<span class={`${styles.badge} ${styles.badgeWrite}`}>
										write
									</span>
								)}
							</div>
							<div class={styles.inputTable}>
								<For each={Object.entries(t.input)}>
									{([key, value]) => (
										<div class={styles.inputRow}>
											<span class={styles.inputKey}>{key}</span>
											<InputValue
												value={value}
												displayNames={props.displayNames}
											/>
										</div>
									)}
								</For>
							</div>
						</div>
					);
				}}
			</For>
			<div class={styles.actions}>
				<Button
					onClick={props.onApprove}
					disabled={props.disabled}
					size="small"
					variant={hasDestructive() ? "danger" : "primary"}
				>
					{hasDestructive() ? "Allow (irreversible)" : "Allow all"}
				</Button>
				<Button
					onClick={props.onDeny}
					variant="secondary"
					disabled={props.disabled}
					size="small"
				>
					Deny
				</Button>
			</div>
		</div>
	);
}
