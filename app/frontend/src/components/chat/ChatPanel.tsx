import {
	type Accessor,
	createResource,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { useUi } from "../../ui/UiContext";
import { ChatInput } from "./ChatInput";
import {
	ChatMessage,
	type ChatMessageData,
	type MessageUsage,
	type ToolUse,
} from "./ChatMessage";
import styles from "./ChatPanel.module.css";
import { ToolApproval } from "./ToolApproval";

type ConversationSummary = {
	id: string;
	title: string;
	model: string;
	updated_at: string;
};

type DisplayName = { label: string; url?: string };

type PendingApproval = {
	conversationId: string;
	model: string;
	tools: ToolUse[];
	displayNames: Record<string, DisplayName>;
	contextNoteId?: string;
	contextNoteTitle?: string;
	contextNoteType?: string;
	nookName?: string;
};

import type { NotePreviewController } from "../../pages/nook/NookContext";

type Props = {
	/** AI memory nook ID — conversations are stored here */
	chatNookId: string;
	/** Current nook ID — context for AI tool calls */
	contextNookId: string;
	currentNoteId?: string;
	currentNoteTitle?: string;
	currentNoteType?: string;
	/** Current browser path — gives AI context about what view the user is on */
	currentPath?: string;
	onClose: () => void;
	onNavigateToNote?: (noteId: string) => void;
	notePreview?: NotePreviewController;
};

async function fetchConversations(
	nookId: string,
): Promise<ConversationSummary[]> {
	const res = await fetch(
		`/api/conversations?nook_id=${encodeURIComponent(nookId)}`,
		{
			credentials: "include",
		},
	);
	if (!res.ok) return [];
	const data = (await res.json()) as { conversations?: ConversationSummary[] };
	return data.conversations ?? [];
}

async function fetchMessages(
	conversationId: string,
): Promise<ChatMessageData[]> {
	const res = await fetch(
		`/api/conversations/${encodeURIComponent(conversationId)}/messages`,
		{
			credentials: "include",
		},
	);
	if (!res.ok) return [];
	const data = (await res.json()) as {
		messages?: Array<{ role: string; content: unknown }>;
	};
	const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z\]/;
	const out: ChatMessageData[] = [];
	for (const m of data.messages ?? []) {
		if (m.role === "user") {
			// Extract text from content blocks
			const blocks = Array.isArray(m.content) ? m.content : [];
			const text = blocks
				.filter(
					(b): b is { type: string; text: string } =>
						typeof b === "object" &&
						b !== null &&
						"type" in b &&
						(b as Record<string, unknown>).type === "text",
				)
				.map((b) => b.text)
				.join("");
			const tsMatch = TS_RE.exec(text);
			const sentAt = tsMatch ? new Date(`${tsMatch[1]}Z`).getTime() : undefined;
			if (text.trim() && !text.includes("[nudge]"))
				out.push({ role: "user", text, sentAt });
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const text = blocks
				.filter(
					(b): b is { type: string; text: string } =>
						typeof b === "object" &&
						b !== null &&
						"type" in b &&
						(b as Record<string, unknown>).type === "text",
				)
				.map((b) => b.text)
				.join("");
			const toolUses: ToolUse[] = blocks
				.filter(
					(
						b,
					): b is {
						type: string;
						id: string;
						name: string;
						input: Record<string, unknown>;
					} =>
						typeof b === "object" &&
						b !== null &&
						(b as Record<string, unknown>).type === "tool_use",
				)
				.map((b) => ({ id: b.id, name: b.name, input: b.input }));
			if (text.trim() || toolUses.length > 0) {
				out.push({ role: "assistant", text, toolUses, streaming: false });
			}
		}
	}
	return out;
}

export function ChatPanel(props: Props) {
	const ui = useUi();
	// ── list view state ──────────────────────────────────────
	const [convRefetch, setConvRefetch] = createSignal(0);
	const [conversations] = createResource(
		() => ({ nookId: props.chatNookId, rev: convRefetch() }),
		({ nookId }) => fetchConversations(nookId),
	);

	// ── chat view state ──────────────────────────────────────
	const [view, setView] = createSignal<"list" | "chat">("list");
	const [activeTitle, setActiveTitle] = createSignal("");
	const [messages, setMessages] = createSignal<ChatMessageData[]>([]);
	const [conversationId, setConversationId] = createSignal<string | null>(null);
	const [model, setModel] = createSignal("claude-sonnet-4-6");
	const [streaming, setStreaming] = createSignal(false);
	const [contextUsage, setContextUsage] = createSignal<{
		ratio: number;
		level: "" | "warning" | "critical";
	}>({ ratio: 0, level: "" });
	const [reconnecting, setReconnecting] = createSignal(false);
	const [pendingApproval, setPendingApproval] =
		createSignal<PendingApproval | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [quickReplyDismissed, setQuickReplyDismissed] = createSignal(false);

	let chatInputEl: HTMLTextAreaElement | undefined;

	// Separate reactive signals for streaming tool input — avoids thrashing messages array
	const toolInputStreams = new Map<
		string,
		{ get: Accessor<string>; set: (v: string) => void }
	>();
	const getToolInputStream = (toolId: string): Accessor<string> => {
		let entry = toolInputStreams.get(toolId);
		if (!entry) {
			const [get, set] = createSignal("");
			entry = { get, set };
			toolInputStreams.set(toolId, entry);
		}
		return entry.get;
	};

	let abortCtrl: AbortController | null = null;
	let messagesEl: HTMLDivElement | undefined;
	let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
	let isNudge = false;

	const KEEP_ALIVE_MS = 4 * 60 * 1000; // 4 minutes

	const clearKeepAlive = () => {
		if (keepAliveTimer) {
			clearTimeout(keepAliveTimer);
			keepAliveTimer = null;
		}
	};

	onCleanup(() => {
		abortCtrl?.abort();
		clearKeepAlive();
	});

	let userScrolledAway = false;

	const checkUserScroll = () => {
		if (!messagesEl) return;
		const distFromBottom =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
		userScrolledAway = distFromBottom > 80;
	};

	const scrollToBottom = (force = false) => {
		if (!messagesEl) return;
		if (force || !userScrolledAway) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
			userScrolledAway = false;
		}
	};

	// ── resume a past conversation ───────────────────────────
	const openConversation = async (conv: ConversationSummary) => {
		setActiveTitle(conv.title || "Chat");
		setModel(conv.model || "claude-sonnet-4-6");
		setConversationId(conv.id);
		setMessages([]);
		setError(null);
		setPendingApproval(null);
		const loaded = await fetchMessages(conv.id);
		setMessages(loaded);
		setView("chat");
		setTimeout(() => scrollToBottom(true), 0);
	};

	const startNewChat = () => {
		clearKeepAlive();
		isNudge = false;
		setMessages([]);
		setConversationId(null);
		setActiveTitle("New chat");
		setError(null);
		setPendingApproval(null);
		setView("chat");
	};

	const backToList = () => {
		clearKeepAlive();
		isNudge = false;
		abortCtrl?.abort();
		setStreaming(false);
		setPendingApproval(null);
		setView("list");
		setConvRefetch((n) => n + 1);
	};

	// ── streaming helpers ────────────────────────────────────
	const appendDelta = (delta: string) => {
		setMessages((prev) => {
			const last = prev[prev.length - 1];
			if (
				last?.role === "assistant" &&
				(last as { streaming?: boolean }).streaming
			) {
				return [
					...prev.slice(0, -1),
					{
						role: "assistant",
						text: (last as { text: string }).text + delta,
						toolUses: (last as { toolUses?: ToolUse[] }).toolUses,
						streaming: true,
					} as ChatMessageData,
				];
			}
			return [
				...prev,
				{ role: "assistant", text: delta, streaming: true } as ChatMessageData,
			];
		});
		scrollToBottom();
	};

	const addToolUseStart = (id: string, name: string) => {
		setMessages((prev) => {
			const last = prev[prev.length - 1];
			const partial: ToolUse = { id, name, input: {}, progress: "running" };
			if (last?.role === "assistant") {
				return [
					...prev.slice(0, -1),
					{
						role: "assistant",
						text: (last as { text: string }).text,
						toolUses: [
							...((last as { toolUses?: ToolUse[] }).toolUses ?? []),
							partial,
						],
						streaming: (last as { streaming?: boolean }).streaming,
					} as ChatMessageData,
				];
			}
			return [
				...prev,
				{
					role: "assistant",
					text: "",
					toolUses: [partial],
					streaming: true,
				} as ChatMessageData,
			];
		});
		scrollToBottom();
	};

	const appendToolInputDelta = (toolId: string, delta: string) => {
		let entry = toolInputStreams.get(toolId);
		if (!entry) {
			const [get, set] = createSignal("");
			entry = { get, set };
			toolInputStreams.set(toolId, entry);
		}
		entry.set(entry.get() + delta);
		scrollToBottom();
	};

	const addToolUse = (tool: ToolUse) => {
		toolInputStreams.delete(tool.id);
		setMessages((prev) => {
			const last = prev[prev.length - 1];
			if (last?.role === "assistant") {
				const existing = (last as { toolUses?: ToolUse[] }).toolUses ?? [];
				// Replace the partial placeholder if it exists, otherwise append
				const idx = existing.findIndex((t) => t.id === tool.id);
				const updated =
					idx >= 0
						? [...existing.slice(0, idx), tool, ...existing.slice(idx + 1)]
						: [...existing, tool];
				return [
					...prev.slice(0, -1),
					{
						role: "assistant",
						text: (last as { text: string }).text,
						toolUses: updated,
						streaming: (last as { streaming?: boolean }).streaming,
					} as ChatMessageData,
				];
			}
			return [
				...prev,
				{ role: "assistant", text: "", toolUses: [tool] } as ChatMessageData,
			];
		});
		scrollToBottom();
	};

	const finalizeAssistant = () => {
		setMessages((prev) => {
			const last = prev[prev.length - 1];
			if (last?.role === "assistant") {
				return [
					...prev.slice(0, -1),
					{
						role: "assistant",
						text: (last as { text: string }).text,
						toolUses: (last as { toolUses?: ToolUse[] }).toolUses,
						streaming: false,
					} as ChatMessageData,
				];
			}
			return prev;
		});
	};

	// ── reconnect / recovery ─────────────────────────────────
	const attemptRecovery = async (convId: string) => {
		setReconnecting(true);
		// Give the server a moment to finish saving before we poll
		await new Promise<void>((r) => setTimeout(r, 1000));
		try {
			const loaded = await fetchMessages(convId);
			const lastLoaded = loaded[loaded.length - 1];
			if (lastLoaded?.role === "assistant") {
				// Server completed the response — replace partial state with saved version
				setMessages(loaded);
				setError(null);
			} else {
				// Server was also cut off — keep whatever we rendered, flag it
				finalizeAssistant();
				setError("Connection lost. Response may be incomplete.");
			}
		} catch {
			finalizeAssistant();
			setError("Connection lost. Response may be incomplete.");
		} finally {
			setStreaming(false);
			setReconnecting(false);
		}
	};

	const consumeStream = (
		reader: ReadableStreamDefaultReader<Uint8Array>,
		currentModel: string,
	) => {
		const decoder = new TextDecoder();
		let buf = "";
		let terminalEventSeen = false;

		const processChunk = async (): Promise<void> => {
			const { value, done } = await reader.read();
			if (done) {
				if (!terminalEventSeen) {
					// Stream closed without a clean terminal event — try to recover
					const convId = conversationId();
					if (convId) {
						void attemptRecovery(convId);
					} else {
						finalizeAssistant();
						setStreaming(false);
						setError("Connection lost.");
					}
				}
				return;
			}
			buf += decoder.decode(value, { stream: true });
			const parts = buf.split("\n\n");
			buf = parts.pop() ?? "";

			for (const part of parts) {
				const lines = part.split("\n");
				const eventLine = lines.find((l) => l.startsWith("event: "));
				const dataLine = lines.find((l) => l.startsWith("data: "));
				if (!eventLine || !dataLine) continue;

				const event = eventLine.slice(7);
				const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;

				if (event === "conversation") {
					const cid = data.conversation_id as string;
					setConversationId(cid);
				} else if (event === "text_delta") {
					appendDelta(data.delta as string);
				} else if (event === "tool_use_start") {
					addToolUseStart(data.id as string, data.name as string);
				} else if (event === "tool_input_delta") {
					appendToolInputDelta(data.id as string, data.delta as string);
				} else if (event === "tool_use") {
					addToolUse({
						id: data.id as string,
						name: data.name as string,
						input: data.input as Record<string, unknown>,
					});
				} else if (event === "awaiting_approval") {
					terminalEventSeen = true;
					finalizeAssistant();
					setStreaming(false);
					setPendingApproval({
						conversationId: data.conversation_id as string,
						model: currentModel,
						tools: data.tools as ToolUse[],
						displayNames: (data.display_names ?? {}) as Record<
							string,
							DisplayName
						>,
						contextNoteId: props.currentNoteId,
						nookName: data.nook_name as string | undefined,
					});
					return;
				} else if (event === "search_agent_progress") {
					// Update the last assistant message's tool with progress status
					const toolId = data.tool_use_id as string;
					const status = data.status as string;
					setMessages((prev) => {
						const last = prev[prev.length - 1];
						if (
							last?.role === "assistant" &&
							(last as { toolUses?: ToolUse[] }).toolUses
						) {
							const toolUses =
								(last as { toolUses?: ToolUse[] }).toolUses ?? [];
							const updated = toolUses.map((t) =>
								t.id === toolId ? { ...t, progress: status } : t,
							);
							return [
								...prev.slice(0, -1),
								{ ...last, toolUses: updated } as ChatMessageData,
							];
						}
						return prev;
					});
					scrollToBottom();
				} else if (event === "done") {
					terminalEventSeen = true;
					finalizeAssistant();
					setStreaming(false);
					// Update context usage indicator + attach usage to last assistant message
					const usage = data.usage as
						| {
								input_tokens?: number;
								output_tokens?: number;
								cache_creation_input_tokens?: number;
								cache_read_input_tokens?: number;
								context_limit?: number;
						  }
						| undefined;
					if (usage?.context_limit) {
						const totalInput =
							(usage.input_tokens ?? 0) +
							(usage.cache_creation_input_tokens ?? 0) +
							(usage.cache_read_input_tokens ?? 0);
						const ratio =
							(totalInput + (usage.output_tokens ?? 0)) / usage.context_limit;
						setContextUsage({
							ratio,
							level: ratio > 0.9 ? "critical" : ratio > 0.5 ? "warning" : "",
						});
						// Attach usage to last assistant message for debug display
						const msgUsage: MessageUsage = {
							input_tokens: usage.input_tokens ?? 0,
							output_tokens: usage.output_tokens ?? 0,
							cache_creation_input_tokens:
								usage.cache_creation_input_tokens ?? 0,
							cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
							context_limit: usage.context_limit ?? 0,
						};
						setMessages((prev) => {
							const last = prev[prev.length - 1];
							if (last?.role === "assistant") {
								return [...prev.slice(0, -1), { ...last, usage: msgUsage }];
							}
							return prev;
						});
					}
					// Start keep-alive timer (one nudge only, then let cache expire)
					clearKeepAlive();
					if (isNudge) {
						isNudge = false;
					} else {
						keepAliveTimer = setTimeout(() => void sendNudge(), KEEP_ALIVE_MS);
					}
					return;
				} else if (event === "error") {
					terminalEventSeen = true;
					finalizeAssistant();
					setStreaming(false);
					setError(data.message as string);
					return;
				}
			}
			return processChunk();
		};

		processChunk().catch((err: unknown) => {
			setStreaming(false);
			if (err instanceof Error && err.name !== "AbortError")
				setError(err.message);
		});
	};

	// ── send message ─────────────────────────────────────────
	const send = async (text: string, selectedModel: string) => {
		clearKeepAlive();
		isNudge = false;
		setError(null);
		setModel(selectedModel);
		setQuickReplyDismissed(false);
		setMessages((prev) => [
			...prev,
			{ role: "user", text, sentAt: Date.now() } as ChatMessageData,
		]);
		scrollToBottom(true);
		setStreaming(true);

		abortCtrl?.abort();
		abortCtrl = new AbortController();

		try {
			const res = await fetch(
				`/nooks/${encodeURIComponent(props.contextNookId)}/chat`,
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message: text,
						model: selectedModel,
						conversation_id: conversationId() ?? undefined,
						context_note_id: props.currentNoteId ?? undefined,
						context_note_title: props.currentNoteTitle ?? undefined,
						context_note_type: props.currentNoteType ?? undefined,
						context_path: props.currentPath ?? undefined,
					}),
					signal: abortCtrl.signal,
				},
			);
			if (!res.ok || !res.body) {
				setStreaming(false);
				setError(`HTTP ${res.status}`);
				return;
			}
			consumeStream(res.body.getReader(), selectedModel);
		} catch (err) {
			setStreaming(false);
			if (err instanceof Error && err.name !== "AbortError")
				setError(err.message);
		}
	};

	// ── cache keep-alive nudge ───────────────────────────────
	const sendNudge = async () => {
		if (streaming() || !conversationId()) return;
		isNudge = true;
		setStreaming(true);
		abortCtrl?.abort();
		abortCtrl = new AbortController();
		try {
			const res = await fetch(
				`/nooks/${encodeURIComponent(props.contextNookId)}/chat`,
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message:
							"[nudge] The user has been idle for a few minutes. Send a brief, creative nudge related to the current conversation — a follow-up thought, a question, or a playful check-in. Keep it to 1-2 sentences. Do NOT mention that this is a system prompt or that you were asked to nudge.",
						model: model(),
						conversation_id: conversationId(),
						context_note_id: props.currentNoteId ?? undefined,
						context_note_title: props.currentNoteTitle ?? undefined,
						context_note_type: props.currentNoteType ?? undefined,
					}),
					signal: abortCtrl.signal,
				},
			);
			if (!res.ok || !res.body) {
				setStreaming(false);
				isNudge = false;
				return;
			}
			consumeStream(res.body.getReader(), model());
		} catch {
			setStreaming(false);
			isNudge = false;
		}
	};

	// ── tool approval ────────────────────────────────────────
	const submitToolResults = async (approved: boolean) => {
		const pa = pendingApproval();
		if (!pa) return;
		setPendingApproval(null);
		if (approved) {
			for (const tool of pa.tools) {
				if (
					tool.name === "open_note" &&
					typeof tool.input.note_id === "string"
				) {
					props.onNavigateToNote?.(tool.input.note_id);
				}
				if (
					tool.name === "start_new_chat" &&
					typeof tool.input.message === "string"
				) {
					// Start a new chat with the AI's suggested message
					startNewChat();
					setTimeout(
						() => void send(tool.input.message as string, model()),
						100,
					);
					return;
				}
			}
		}
		setStreaming(true);
		setError(null);

		abortCtrl?.abort();
		abortCtrl = new AbortController();

		try {
			const res = await fetch(
				`/nooks/${encodeURIComponent(props.contextNookId)}/chat/tool-result`,
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						conversation_id: pa.conversationId,
						model: pa.model,
						context_note_id: pa.contextNoteId,
						tool_results: pa.tools.map((t) => ({
							tool_use_id: t.id,
							tool_name: t.name,
							tool_input: t.input,
							approved,
						})),
					}),
					signal: abortCtrl.signal,
				},
			);
			if (!res.ok || !res.body) {
				setStreaming(false);
				setError(`HTTP ${res.status}`);
				return;
			}
			consumeStream(res.body.getReader(), pa.model);
		} catch (err) {
			setStreaming(false);
			if (err instanceof Error && err.name !== "AbortError")
				setError(err.message);
		}
	};

	// ── helpers ──────────────────────────────────────────────
	const formatDate = (iso: string) => {
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	};

	// ── render ───────────────────────────────────────────────
	return (
		<div class={styles.panel}>
			{/* Header */}
			<div class={styles.header}>
				<Show when={view() === "chat"}>
					<button class={styles.backBtn} onClick={backToList} type="button">
						← Back
					</button>
				</Show>
				<h2>
					<Show when={view() === "chat"} fallback="AI Chat">
						{activeTitle() || "Chat"}
					</Show>
				</h2>
				<button class={styles.closeBtn} onClick={props.onClose} type="button">
					✕
				</button>
			</div>
			{/* List view */}
			<Show when={view() === "list"}>
				<div class={styles.listView}>
					<Show when={conversations.loading}>
						<div class={styles.listLoading}>Loading…</div>
					</Show>
					<Show when={!conversations.loading}>
						<Show
							when={(conversations() ?? []).length > 0}
							fallback={
								<p class={styles.listEmpty}>No past conversations yet.</p>
							}
						>
							<div class={styles.listSectionTitle}>Recent</div>
							<div class={styles.listSection}>
								<For each={conversations() ?? []}>
									{(conv) => (
										<button
											class={styles.convItem}
											type="button"
											onClick={() => void openConversation(conv)}
										>
											<span class={styles.convTitle}>
												{conv.title || "Untitled"}
											</span>
											<span class={styles.convMeta}>
												{formatDate(conv.updated_at)} · {conv.model}
											</span>
										</button>
									)}
								</For>
							</div>
						</Show>
					</Show>
				</div>
				<div class={styles.newChatArea}>
					<ChatInput
						onSend={(text, m) => {
							startNewChat();
							void send(text, m);
						}}
						disabled={false}
						model={model()}
						onModelChange={setModel}
					/>
				</div>
			</Show>

			{/* Chat view */}
			<Show when={view() === "chat"}>
				<div
					class={styles.messages}
					ref={(el) => {
						messagesEl = el;
						el.addEventListener("scroll", checkUserScroll);
					}}
				>
					<Show
						when={messages().length > 0}
						fallback={
							<p class={styles.empty}>Ask anything about your notes.</p>
						}
					>
						<For each={messages()}>
							{(m, i) => (
								<ChatMessage
									message={m}
									notePreview={props.notePreview}
									onNavigateToNote={props.onNavigateToNote}
									memoryNookId={props.chatNookId}
									debugMode={ui.debugMode()}
									getToolInputStream={getToolInputStream}
									onQuickReply={
										i() === messages().length - 1 && !quickReplyDismissed()
											? (text) => void send(text, model())
											: undefined
									}
									onQuickReplyOther={
										i() === messages().length - 1
											? () => {
													setQuickReplyDismissed(true);
													chatInputEl?.focus();
												}
											: undefined
									}
									inputDisabled={
										streaming() || reconnecting() || pendingApproval() !== null
									}
								/>
							)}
						</For>
					</Show>

					<Show when={pendingApproval() !== null}>
						<ToolApproval
							// biome-ignore lint/style/noNonNullAssertion: guarded by Show when={pendingApproval() !== null}
							tools={pendingApproval()!.tools}
							// biome-ignore lint/style/noNonNullAssertion: guarded by Show when={pendingApproval() !== null}
							displayNames={pendingApproval()!.displayNames}
							onApprove={() => void submitToolResults(true)}
							onDeny={() => void submitToolResults(false)}
							disabled={streaming()}
							notePreview={props.notePreview}
							nookName={pendingApproval()?.nookName}
						/>
					</Show>

					<Show when={reconnecting()}>
						<div style={{ color: "#6b7280", "font-size": "0.8125rem" }}>
							Reconnecting…
						</div>
					</Show>

					<Show when={error() !== null}>
						<div style={{ color: "#b91c1c", "font-size": "0.8125rem" }}>
							Error: {error()}
						</div>
					</Show>
				</div>

				<div class={styles.inputArea}>
					<Show when={streaming()}>
						<div class={styles.thinkingBar} />
					</Show>
					<Show when={streaming()}>
						<button
							type="button"
							onClick={() => {
								abortCtrl?.abort();
								setStreaming(false);
								setMessages((prev) => {
									const last = prev[prev.length - 1];
									if (
										last?.role === "assistant" &&
										(last as { streaming?: boolean }).streaming
									) {
										return [
											...prev.slice(0, -1),
											{ ...last, streaming: false } as ChatMessageData,
										];
									}
									return prev;
								});
							}}
							style={{
								display: "block",
								width: "100%",
								padding: "6px",
								background: "none",
								border: "1px solid var(--color-border, #ddd)",
								"border-radius": "4px",
								cursor: "pointer",
								color: "var(--color-text-muted)",
								"font-size": "0.8rem",
								"margin-bottom": "6px",
							}}
						>
							Stop generating
						</button>
					</Show>
					<ChatInput
						onSend={(text, m) => void send(text, m)}
						disabled={
							streaming() || reconnecting() || pendingApproval() !== null
						}
						model={model()}
						onModelChange={setModel}
						inputRef={(el) => {
							chatInputEl = el;
						}}
					/>
					<Show when={contextUsage().ratio > 0}>
						{(() => {
							const pct = () => Math.round(contextUsage().ratio * 100);
							const color = () =>
								contextUsage().ratio > 0.9
									? "var(--color-danger, #ef4444)"
									: contextUsage().ratio > 0.5
										? "var(--color-warning, #f59e0b)"
										: "var(--color-text-faint, #ccc)";
							// SVG circle: radius=8, circumference=50.27
							const circumference = 50.27;
							const offset = () => circumference * (1 - contextUsage().ratio);
							return (
								<div
									style={{
										"margin-top": "4px",
										display: "flex",
										"align-items": "center",
										"justify-content": "flex-end",
										gap: "4px",
									}}
								>
									<svg
										width="18"
										height="18"
										viewBox="0 0 20 20"
										aria-hidden="true"
									>
										<title>Context usage</title>
										<circle
											cx="10"
											cy="10"
											r="8"
											fill="none"
											stroke="var(--color-border-light, #eee)"
											stroke-width="2.5"
										/>
										<circle
											cx="10"
											cy="10"
											r="8"
											fill="none"
											stroke={color()}
											stroke-width="2.5"
											stroke-dasharray={String(circumference)}
											stroke-dashoffset={String(offset())}
											stroke-linecap="round"
											transform="rotate(-90 10 10)"
											style={{
												transition: "stroke-dashoffset 0.3s, stroke 0.3s",
											}}
										/>
									</svg>
									<span
										style={{
											"font-size": "0.65rem",
											color: color(),
											"white-space": "nowrap",
										}}
									>
										{pct()}%
									</span>
								</div>
							);
						})()}
					</Show>
				</div>
			</Show>
		</div>
	);
}
