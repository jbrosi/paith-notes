import {
	type Accessor,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import type { NotePreviewController } from "../../pages/nook/NookContext";
import { MarkdownView } from "../MarkdownView";
import styles from "./ChatMessage.module.css";

export type ToolUse = {
	id: string;
	name: string;
	input: Record<string, unknown>;
	progress?: string;
};

export type MessageUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	context_limit: number;
};

export type ChatMessageData =
	| {
			role: "user";
			text: string;
			sentAt?: number;
			/** Identified speaker name when the voice container matched
			 *  the utterance to an enrolled voiceprint. Null/undefined
			 *  means the speaker is unknown (typed text or no match). */
			speaker?: string | null;
			/** Cosine-similarity score 0-1 from speaker matching. */
			speakerConfidence?: number;
			/** Whisper-reported language code. */
			language?: string;
			/** Audio clip length in seconds. */
			durationSec?: number;
	  }
	| {
			role: "assistant";
			text: string;
			toolUses?: ToolUse[];
			streaming?: boolean;
			usage?: MessageUsage;
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
	debugMode?: boolean;
	/** Returns a reactive signal for the streaming partial input of a tool */
	getToolInputStream?: (toolId: string) => Accessor<string>;
	/** Send a message on behalf of the user (for quick-reply buttons) */
	onQuickReply?: (text: string) => void;
	/** Focus the chat input for free-form reply (dismisses quick-reply buttons) */
	onQuickReplyOther?: () => void;
	/** Whether input is disabled (streaming/etc) — hides quick-reply buttons */
	inputDisabled?: boolean;
};

/** Strip the metadata prefix added by the backend.
 *  Format: `[<ISO timestamp>] [spoken by <name> (confidence X.XX)?]? [Note: "title" (id, type: t)]?\n`
 *  All three brackets are optional except the timestamp; the order is
 *  fixed (see MCP's buildMessageText). */
const META_RE =
	/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\](?: \[spoken by [^\]]+\])?(?: \[Note: "[^"]*" \([^)]+\)])?\n/;
/** Captures speaker name (group 1) and optional confidence (group 2)
 *  from the metadata prefix when present. Confidence is optional so
 *  older saved conversations (without the score) still parse. */
const SPEAKER_RE =
	/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\] \[spoken by ([^\](]+?)(?: \(confidence ([\d.]+)\))?\]/;

function stripMeta(text: string): string {
	return text.replace(META_RE, "");
}

/** Pull the speaker name out of the metadata prefix, if present. Used
 *  to drive a "spoken by Anna" badge on the message bubble. */
export function extractSpeaker(text: string): string | null {
	const m = SPEAKER_RE.exec(text);
	return m ? m[1].trim() : null;
}

/** Pull the speaker-match confidence from the metadata prefix, if
 *  the tag includes it. Older saved messages won't have it. */
export function extractSpeakerConfidence(text: string): number | null {
	const m = SPEAKER_RE.exec(text);
	if (!m || !m[2]) return null;
	const n = Number.parseFloat(m[2]);
	return Number.isFinite(n) ? n : null;
}

function formatTimeAgo(ms: number): string {
	const seconds = Math.floor((Date.now() - ms) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Self-updating relative timestamp. Only renders when > 1 minute old. */
function TimeAgo(props: { epoch: number }) {
	const [now, setNow] = createSignal(Date.now());
	const timer = setInterval(() => setNow(Date.now()), 30_000);
	onCleanup(() => clearInterval(timer));
	const age = () => now() - props.epoch;
	return (
		<Show when={age() >= 60_000}>
			<span
				title={new Date(props.epoch).toLocaleString()}
				style={{
					"font-size": "0.6rem",
					color: "var(--color-text-faint, #999)",
				}}
			>
				{formatTimeAgo(props.epoch)}
			</span>
		</Show>
	);
}

/** Friendly labels for tool names */
const TOOL_LABELS: Record<string, string> = {
	create_note: "Writing note",
	update_note: "Updating note",
	get_note: "Reading note",
	search_notes: "Searching notes",
	explore_notes: "Exploring notes",
	delete_note: "Deleting note",
	create_note_link: "Linking notes",
	delete_note_link: "Removing link",
	edit_note: "Editing note",
	read_note_lines: "Reading note",
	get_note_toc: "Reading note outline",
	get_note_part: "Reading note section",
	search_in_note: "Searching within note",
	create_note_type: "Creating type",
	update_note_type: "Updating type",
	memory_create: "Saving to memory",
	memory_update: "Updating memory",
	memory_search: "Searching memory",
	memory_get: "Reading memory",
	search_agent: "Researching",
	edit_note_agent: "Editing note (sub-agent)",
};

/** Unescape JSON string escapes for display */
function unescapeJson(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/** Extract a preview snippet from partial JSON input */
function extractPreview(partialInput: string): {
	title?: string;
	body: string;
} {
	const titleMatch = partialInput.match(/"title"\s*:\s*"([^"]*)/);
	const contentMatch = partialInput.match(/"content"\s*:\s*"([\s\S]*?)(?:"|$)/);
	const taskMatch = partialInput.match(/"task"\s*:\s*"([\s\S]*?)(?:"|$)/);
	const qMatch = partialInput.match(/"q"\s*:\s*"([^"]*)/);

	if (taskMatch) return { body: unescapeJson(taskMatch[1]) };
	if (qMatch) return { body: unescapeJson(qMatch[1]) };
	if (contentMatch) {
		return {
			title: titleMatch ? titleMatch[1] : undefined,
			body: unescapeJson(contentMatch[1]),
		};
	}
	if (titleMatch) return { body: `"${titleMatch[1]}"` };
	return { body: "" };
}

/** Shows streaming preview of a tool being built, auto-scrolling to bottom */
function ToolStreamPreview(props: {
	tool: ToolUse;
	partialInput: Accessor<string>;
}) {
	const label = () => TOOL_LABELS[props.tool.name] ?? props.tool.name;
	const preview = () => {
		const raw = props.partialInput();
		if (!raw) return null;
		return extractPreview(raw);
	};

	let previewEl: HTMLDivElement | undefined;

	const scrollPreview = () => {
		if (previewEl) previewEl.scrollTop = previewEl.scrollHeight;
	};

	return (
		<div class={styles.toolStream}>
			<div class={styles.toolStreamHeader}>
				<span class={styles.toolSpinner} />
				<span class={styles.toolStreamLabel}>
					{label()}
					<Show when={preview()?.title}>
						{" — "}
						{preview()?.title}
					</Show>
					…
				</span>
			</div>
			<Show when={preview()?.body}>
				<div
					class={styles.toolStreamPreview}
					ref={(el) => {
						previewEl = el;
						queueMicrotask(scrollPreview);
					}}
				>
					{(() => {
						queueMicrotask(scrollPreview);
						return preview()?.body;
					})()}
				</div>
			</Show>
		</div>
	);
}

export function ChatMessage(props: Props) {
	const m = () => props.message;

	return (
		<div class={`${styles.message} ${styles[m().role]}`}>
			<Show when={m().role === "user"}>
				{(() => {
					// Speaker attribution: prefer the explicit fields (set on
					// real-time sends), fall back to parsing the `[spoken by …]`
					// tag from the saved text (history reload).
					const u = m() as {
						text: string;
						speaker?: string | null;
						speakerConfidence?: number;
						language?: string;
						durationSec?: number;
					};
					const speaker = u.speaker ?? extractSpeaker(u.text);
					const confidence =
						u.speakerConfidence ?? extractSpeakerConfidence(u.text);
					const badgeTitle =
						confidence != null
							? `Identified by voiceprint (confidence ${confidence.toFixed(2)})`
							: "Identified by voiceprint";
					return (
						<>
							<Show when={speaker}>
								<div
									style={{
										"font-size": "0.75rem",
										color: "var(--color-text-secondary)",
										"margin-bottom": "2px",
										"text-align": "right",
									}}
									title={badgeTitle}
								>
									🎤 {speaker}
								</div>
							</Show>
							<div class={styles.bubble}>{stripMeta(u.text)}</div>
							<Show
								when={
									props.debugMode &&
									(u.language ||
										u.durationSec !== undefined ||
										u.speakerConfidence !== undefined)
								}
							>
								<div
									style={{
										"font-size": "0.7rem",
										color: "var(--color-text-faint, #999)",
										"margin-top": "2px",
										"text-align": "right",
										"font-variant-numeric": "tabular-nums",
									}}
								>
									<Show when={u.language}>
										<span title="Detected language">{u.language}</span>
									</Show>
									<Show when={u.durationSec !== undefined}>
										<span
											style={{ "margin-left": "8px" }}
											title="Recorded audio length"
										>
											{u.durationSec?.toFixed(1)}s
										</span>
									</Show>
									<Show when={u.speakerConfidence !== undefined}>
										<span
											style={{ "margin-left": "8px" }}
											title="Speaker-match cosine similarity"
										>
											🎤 {(u.speakerConfidence ?? 0).toFixed(2)}
										</span>
									</Show>
								</div>
							</Show>
						</>
					);
				})()}
				<Show when={(m() as { sentAt?: number }).sentAt}>
					<div style={{ "text-align": "right", "margin-top": "2px" }}>
						<TimeAgo epoch={(m() as { sentAt: number }).sentAt} />
					</div>
				</Show>
			</Show>
			<Show when={m().role === "assistant"}>
				<Show when={(m() as { text: string }).text.trim() !== ""}>
					<MarkdownView
						content={(m() as { text: string }).text}
						notePreview={props.notePreview}
						class={`${styles.bubble} ${(m() as { streaming?: boolean }).streaming ? styles.streaming : ""}`}
					/>
				</Show>
				<For
					each={
						(m() as { toolUses?: ToolUse[] }).toolUses?.filter(
							(t) => t.name !== "ask_user",
						) ?? []
					}
				>
					{(t) => (
						<Show
							when={t.progress !== "running"}
							fallback={
								<ToolStreamPreview
									tool={t}
									partialInput={props.getToolInputStream?.(t.id) ?? (() => "")}
								/>
							}
						>
							<div class={styles.toolChip}>
								<Switch fallback={<span>⚙</span>}>
									<Match when={t.name === "search_agent" && t.progress}>
										<span class={styles.toolSpinner} />
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
																		onMouseLeave={() =>
																			props.notePreview?.hide()
																		}
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
						</Show>
					)}
				</For>
				{/* Quick-reply buttons from ask_user tool */}
				<Show
					when={
						!props.inputDisabled &&
						props.onQuickReply &&
						(m() as { toolUses?: ToolUse[] }).toolUses?.find(
							(t) => t.name === "ask_user",
						)
					}
				>
					{(askTool) => (
						<div class={styles.quickReplyRow}>
							<For
								each={((askTool().input.options as string[]) ?? []).slice(0, 5)}
							>
								{(option) => (
									<button
										type="button"
										class={styles.quickReplyBtn}
										onClick={() => props.onQuickReply?.(option)}
									>
										{option}
									</button>
								)}
							</For>
							<button
								type="button"
								class={`${styles.quickReplyBtn} ${styles.quickReplyOther}`}
								onClick={() => props.onQuickReplyOther?.()}
							>
								{(askTool().input.other_label as string) || "Other…"}
							</button>
						</div>
					)}
				</Show>
			</Show>
			<Show
				when={
					props.debugMode &&
					m().role === "assistant" &&
					(m() as { usage?: MessageUsage }).usage
				}
			>
				{(() => {
					// biome-ignore lint/style/noNonNullAssertion: guarded by Show when={...usage}
					const u = () => (m() as { usage?: MessageUsage }).usage!;
					const fmt = (n: number) =>
						n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
					const totalInput = () =>
						u().input_tokens +
						u().cache_creation_input_tokens +
						u().cache_read_input_tokens;
					const cacheHitPct = () =>
						totalInput() > 0
							? Math.round((u().cache_read_input_tokens / totalInput()) * 100)
							: 0;
					return (
						<div
							style={{
								"font-size": "0.6rem",
								"font-family": "monospace",
								color: "var(--color-text-faint, #999)",
								padding: "2px 6px",
								"margin-top": "2px",
								display: "flex",
								gap: "8px",
								"flex-wrap": "wrap",
							}}
						>
							<span>in:{fmt(totalInput())}</span>
							<span>out:{fmt(u().output_tokens)}</span>
							<span
								style={{
									color:
										u().cache_read_input_tokens > 0
											? "var(--color-success, #22c55e)"
											: undefined,
								}}
							>
								cache↓{fmt(u().cache_read_input_tokens)}
							</span>
							<span
								style={{
									color:
										u().cache_creation_input_tokens > 0
											? "var(--color-warning, #f59e0b)"
											: undefined,
								}}
							>
								cache↑{fmt(u().cache_creation_input_tokens)}
							</span>
							<span>hit:{cacheHitPct()}%</span>
							<span>
								{Math.round(
									((totalInput() + u().output_tokens) / u().context_limit) *
										100,
								)}
								% ctx
							</span>
						</div>
					);
				})()}
			</Show>
		</div>
	);
}
