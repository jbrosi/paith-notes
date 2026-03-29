import { For, Show } from "solid-js";
import type { NotePreviewController } from "../../pages/nook/NookDefaultLayout";
import { MarkdownView } from "../MarkdownView";
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

/** Keys in tool input that typically hold note IDs */
const NOTE_ID_KEYS = new Set(["note_id", "source_note_id", "target_note_id"]);

type Props = {
	message: ChatMessageData;
	notePreview?: NotePreviewController;
	onNavigateToNote?: (noteId: string) => void;
};

export function ChatMessage(props: Props) {
	const m = () => props.message;

	return (
		<div class={`${styles.message} ${styles[m().role]}`}>
			<Show when={m().role === "user"}>
				<div class={styles.bubble}>{(m() as { text: string }).text}</div>
			</Show>
			<Show when={m().role === "assistant"}>
				<Show when={(m() as { text: string }).text.trim() !== ""}>
					<MarkdownView
						content={(m() as { text: string }).text}
						onNoteLinkClick={props.onNavigateToNote}
						notePreview={props.notePreview}
						class={`${styles.bubble} ${(m() as { streaming?: boolean }).streaming ? styles.streaming : ""}`}
					/>
				</Show>
				<For each={(m() as { toolUses?: ToolUse[] }).toolUses ?? []}>
					{(t) => (
						<div class={styles.toolChip}>
							<span>⚙</span>
							<span>
								{t.name}(
								<For each={Object.entries(t.input)}>
									{([key, value], i) => {
										const isNoteId = NOTE_ID_KEYS.has(key);
										const val = String(value ?? "");
										return (
											<>
												{i() > 0 && ", "}
												{key}=
												{isNoteId && props.notePreview ? (
													// biome-ignore lint/a11y/noStaticElementInteractions: hover preview is mouse-only
													<span
														class={styles.noteIdValue}
														onMouseEnter={(e) =>
															props.notePreview?.show(val, e.clientX, e.clientY)
														}
														onMouseLeave={() => props.notePreview?.hide()}
													>
														{val.slice(0, 8)}...
													</span>
												) : (
													JSON.stringify(value)
												)}
											</>
										);
									}}
								</For>
								)
							</span>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}
