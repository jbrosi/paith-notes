import { For, Match, Show, Switch } from "solid-js";
import type { NotePreviewController } from "../../pages/nook/NookContext";
import { MarkdownView } from "../MarkdownView";
import styles from "./ChatMessage.module.css";

export type ToolUse = {
	id: string;
	name: string;
	input: Record<string, unknown>;
	progress?: string;
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
const MEMORY_TOOLS = new Set([
	"memory_get",
	"memory_search",
	"memory_create",
	"memory_update",
]);

type Props = {
	message: ChatMessageData;
	notePreview?: NotePreviewController;
	onNavigateToNote?: (noteId: string) => void;
	memoryNookId?: string;
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
						notePreview={props.notePreview}
						class={`${styles.bubble} ${(m() as { streaming?: boolean }).streaming ? styles.streaming : ""}`}
					/>
				</Show>
				<For each={(m() as { toolUses?: ToolUse[] }).toolUses ?? []}>
					{(t) => (
						<div class={styles.toolChip}>
							<Switch fallback={<span>⚙</span>}>
								<Match when={t.name === "search_agent" && t.progress}>
									<span class={styles.searchAgentSpinner} />
								</Match>
								<Match when={t.name === "search_agent"}>
									<span>🔍</span>
								</Match>
							</Switch>
							<span>
								<Switch
									fallback={
										<>
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
																	onMouseEnter={(e) => {
																		const rect = (
																			e.currentTarget as HTMLElement
																		).getBoundingClientRect();
																		const previewOpts =
																			MEMORY_TOOLS.has(t.name) &&
																			props.memoryNookId
																				? { nookId: props.memoryNookId }
																				: undefined;
																		props.notePreview?.show(
																			val,
																			rect.left,
																			rect.bottom,
																			previewOpts,
																		);
																	}}
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
										</>
									}
								>
									<Match when={t.name === "search_agent"}>
										search_agent: {String(t.input.task ?? "").slice(0, 80)}
										{String(t.input.task ?? "").length > 80 ? "..." : ""}
										<Show when={t.progress}>
											<span
												style={{
													"margin-left": "6px",
													opacity: 0.7,
													"font-style": "italic",
												}}
											>
												— {t.progress}
											</span>
										</Show>
									</Match>
								</Switch>
							</span>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}
