import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { ChatInput } from "./ChatInput";
import { ChatMessage, type ChatMessageData, type ToolUse } from "./ChatMessage";
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
};

import type { NotePreviewController } from "../../pages/nook/NookDefaultLayout";

type Props = {
	nookId: string;
	currentNoteId?: string;
	currentNoteTitle?: string;
	currentNoteType?: string;
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
			if (text.trim()) out.push({ role: "user", text });
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
	// ── list view state ──────────────────────────────────────
	const [convRefetch, setConvRefetch] = createSignal(0);
	const [conversations] = createResource(
		() => ({ nookId: props.nookId, rev: convRefetch() }),
		({ nookId }) => fetchConversations(nookId),
	);

	// ── chat view state ──────────────────────────────────────
	const [view, setView] = createSignal<"list" | "chat">("list");
	const [activeTitle, setActiveTitle] = createSignal("");
	const [messages, setMessages] = createSignal<ChatMessageData[]>([]);
	const [conversationId, setConversationId] = createSignal<string | null>(null);
	const [model, setModel] = createSignal("claude-sonnet-4-6");
	const [streaming, setStreaming] = createSignal(false);
	const [reconnecting, setReconnecting] = createSignal(false);
	const [pendingApproval, setPendingApproval] =
		createSignal<PendingApproval | null>(null);
	const [error, setError] = createSignal<string | null>(null);

	let abortCtrl: AbortController | null = null;
	let messagesEl: HTMLDivElement | undefined;

	onCleanup(() => abortCtrl?.abort());

	const scrollToBottom = () => {
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
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
		setTimeout(scrollToBottom, 0);
	};

	const startNewChat = () => {
		setMessages([]);
		setConversationId(null);
		setActiveTitle("New chat");
		setError(null);
		setPendingApproval(null);
		setView("chat");
	};

	const backToList = () => {
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

	const addToolUse = (tool: ToolUse) => {
		setMessages((prev) => {
			const last = prev[prev.length - 1];
			if (last?.role === "assistant") {
				return [
					...prev.slice(0, -1),
					{
						role: "assistant",
						text: (last as { text: string }).text,
						toolUses: [
							...((last as { toolUses?: ToolUse[] }).toolUses ?? []),
							tool,
						],
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
					});
					return;
				} else if (event === "done") {
					terminalEventSeen = true;
					finalizeAssistant();
					setStreaming(false);
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
		setError(null);
		setModel(selectedModel);
		setMessages((prev) => [...prev, { role: "user", text } as ChatMessageData]);
		scrollToBottom();
		setStreaming(true);

		abortCtrl?.abort();
		abortCtrl = new AbortController();

		try {
			const res = await fetch(
				`/nooks/${encodeURIComponent(props.nookId)}/chat`,
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
			}
		}
		setStreaming(true);
		setError(null);

		abortCtrl?.abort();
		abortCtrl = new AbortController();

		try {
			const res = await fetch(
				`/nooks/${encodeURIComponent(props.nookId)}/chat/tool-result`,
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
				<div class={styles.messages} ref={messagesEl}>
					<Show
						when={messages().length > 0}
						fallback={
							<p class={styles.empty}>Ask anything about your notes.</p>
						}
					>
						<For each={messages()}>
							{(m) => (
								<ChatMessage
									message={m}
									notePreview={props.notePreview}
									onNavigateToNote={props.onNavigateToNote}
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
					<ChatInput
						onSend={(text, m) => void send(text, m)}
						disabled={
							streaming() || reconnecting() || pendingApproval() !== null
						}
						model={model()}
						onModelChange={setModel}
					/>
				</div>
			</Show>
		</div>
	);
}
