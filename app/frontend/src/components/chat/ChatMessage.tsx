import { For, Show } from "solid-js";
import styles from "./ChatMessage.module.css";

export type ToolUse = {
	id: string;
	name: string;
	input: Record<string, unknown>;
};

export type ChatMessageData =
	| { role: "user"; text: string }
	| {
			role: "assistant";
			text: string;
			toolUses?: ToolUse[];
			streaming?: boolean;
	  };

type Props = { message: ChatMessageData };

export function ChatMessage(props: Props) {
	const m = () => props.message;

	return (
		<div class={`${styles.message} ${styles[m().role]}`}>
			<Show when={m().role === "user"}>
				<div class={styles.bubble}>{(m() as { text: string }).text}</div>
			</Show>
			<Show when={m().role === "assistant"}>
				<Show when={(m() as { text: string }).text.trim() !== ""}>
					<div
						class={`${styles.bubble} ${(m() as { streaming?: boolean }).streaming ? styles.streaming : ""}`}
					>
						{(m() as { text: string }).text}
					</div>
				</Show>
				<For each={(m() as { toolUses?: ToolUse[] }).toolUses ?? []}>
					{(t) => (
						<div class={styles.toolChip}>
							<span>⚙</span>
							<span>
								{t.name}({JSON.stringify(t.input)})
							</span>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}
