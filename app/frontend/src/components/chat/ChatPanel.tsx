import {
	type Accessor,
	createEffect,
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
import { awaitVoiceConsent, createTtsQueue } from "./voice";

// Short verb phrase per tool name for voice-mode consent prompts. We
// deliberately do NOT read the tool's inputs aloud (note titles, prompts,
// etc.) — those can be long, contain proper nouns Whisper mangles, or
// leak content the user doesn't want spoken in a shared room. Approval
// shifts to "do you trust the model to do this kind of thing?" rather
// than "verify every parameter by ear."
const TOOL_VERBS: Record<string, string> = {
	create_note: "create a note",
	update_note: "update a note",
	delete_note: "delete a note",
	create_note_type: "create a new note type",
	update_note_type: "update a note type",
	create_note_link: "link two notes",
	generate_image: "generate an image",
	start_new_chat: "start a new chat",
	explore_notes: "explore notes",
	search_notes: "search your notes",
	search_all_nooks: "search across all your nooks",
	get_note_history: "read note history",
	compare_note_versions: "compare note versions",
	get_note_version: "read an older version",
	get_note_summary: "summarize a note",
	get_note_section: "read part of a note",
	open_note: "open a note",
};

function buildConsentPrompt(tools: ReadonlyArray<{ name: string }>): string {
	const verbs = tools.map(
		(t) => TOOL_VERBS[t.name] ?? t.name.replace(/_/g, " "),
	);
	const unique = Array.from(new Set(verbs));
	const list =
		unique.length === 1
			? unique[0]
			: unique.length === 2
				? `${unique[0]} and ${unique[1]}`
				: `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
	return `I want to ${list}. Should I?`;
}

// Loose keyword matchers for EN + DE. Word-boundary regex (no exact
// phrase requirement) so "yes please go ahead" and "ja klar mach das"
// both match. Ambiguous results (both approve + deny words, or
// neither) → re-ask once, then deny on second ambiguity.
const APPROVE_RE =
	/\b(yes|yeah|yep|yup|sure|ok|okay|confirm|please|do it|go ahead|ja|jo|jep|klar|mach|los|sicher|bestätigt|bestätigen|bestätige)\b/i;
const DENY_RE =
	/\b(no|nope|cancel|stop|abort|don'?t|nein|nicht|niemals|abbrechen|stopp|halt|abbruch)\b/i;
function matchConsent(transcript: string): "approve" | "deny" | "ambiguous" {
	const t = transcript.trim();
	if (!t) return "ambiguous";
	const approve = APPROVE_RE.test(t);
	const deny = DENY_RE.test(t);
	if (approve && !deny) return "approve";
	if (deny && !approve) return "deny";
	return "ambiguous";
}

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

async function fetchConversations(): Promise<ConversationSummary[]> {
	const res = await fetch("/api/conversations", { credentials: "include" });
	if (!res.ok) return [];
	const data = (await res.json()) as { conversations?: ConversationSummary[] };
	return data.conversations ?? [];
}

async function deleteConversation(conversationId: string): Promise<boolean> {
	const res = await fetch(
		`/api/conversations/${encodeURIComponent(conversationId)}`,
		{ method: "DELETE", credentials: "include" },
	);
	return res.ok;
}

async function deleteAllConversations(): Promise<boolean> {
	const res = await fetch("/api/conversations", {
		method: "DELETE",
		credentials: "include",
	});
	return res.ok;
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
		() => convRefetch(),
		() => fetchConversations(),
	);

	const onDeleteConv = async (conv: ConversationSummary, e: MouseEvent) => {
		e.stopPropagation();
		if (
			!window.confirm(
				`Delete "${conv.title || "Untitled"}"? This cannot be undone.`,
			)
		) {
			return;
		}
		const ok = await deleteConversation(conv.id);
		if (ok) setConvRefetch((n) => n + 1);
	};

	const onDeleteAll = async () => {
		const count = (conversations() ?? []).length;
		if (count === 0) return;
		if (
			!window.confirm(
				`Delete all ${count} conversation${count === 1 ? "" : "s"}? This cannot be undone.`,
			)
		) {
			return;
		}
		const ok = await deleteAllConversations();
		if (ok) setConvRefetch((n) => n + 1);
	};

	const onExport = () => {
		// Triggers a download via the browser; the endpoint serves a zip with
		// attachment Content-Disposition.
		window.location.href = "/api/me/conversations/export";
	};

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
	const [voiceMode, setVoiceMode] = createSignal(false);
	const [voiceLang, setVoiceLang] = createSignal("en");
	// Derived status for the kiosk-friendly "Thinking…" / "Speaking…"
	// line above the chat input. Only active in voice mode — outside of
	// it the regular streaming spinner / message bubbles carry the load.
	// Order matters: "speaking" wins because once audio starts playing
	// the model may still be generating (streaming() stays true) and we
	// want to reflect the user-perceptible state.
	const voiceStatus = (): "idle" | "thinking" | "speaking" | "consent" => {
		if (!voiceMode()) return "idle";
		// "consent" gates the wake listener in ChatInput off while the
		// approval modal is being voice-handled, so wake and the
		// transient consent recognizer don't fight for the mic.
		if (pendingApproval()) return "consent";
		if (tts.isSpeaking()) return "speaking";
		if (streaming()) return "thinking";
		return "idle";
	};
	// MCP synthesizes server-side now; createTtsQueue is just a decoder +
	// Web Audio scheduler. Frontend never POSTs to /tts directly anymore.
	const tts = createTtsQueue({ debug: () => true });

	// Don't cancel TTS when the approval modal opens. The pre-tool
	// announcement ("I'll add that to your notes now") is queued before
	// awaiting_approval and may still be in the prebuffer when the event
	// arrives, so cancelling here would drop it before it ever plays. The
	// audio is short and lets the user hear what the assistant is asking
	// permission for; if they want silence they can hit Stop or deny.

	// L1 progress indicator for image generation: tracks the wall-clock
	// start of an approved generate_image call so the UI can show
	// "Generating image…" + elapsed seconds while the backend waits on
	// OpenAI. Cleared the moment the next assistant turn starts
	// streaming (or completes).
	const [imageGenStartedAt, setImageGenStartedAt] = createSignal<number | null>(
		null,
	);
	const [nowMs, setNowMs] = createSignal(Date.now());
	let nowTimer: ReturnType<typeof setInterval> | undefined;
	const clearImageGenIndicator = () => {
		setImageGenStartedAt(null);
		if (nowTimer !== undefined) {
			clearInterval(nowTimer);
			nowTimer = undefined;
		}
	};
	const startImageGenIndicator = () => {
		setImageGenStartedAt(Date.now());
		setNowMs(Date.now());
		if (nowTimer === undefined) {
			nowTimer = setInterval(() => setNowMs(Date.now()), 500);
		}
	};
	// Belt-and-braces clear: any path that turns streaming off (done,
	// errors, aborts, awaiting_approval) drops the indicator too. The
	// explicit early-clears in text_delta / tool_use_start give a
	// snappier UI when text starts streaming, but this guarantees no
	// stuck banner.
	createEffect(() => {
		if (!streaming() && imageGenStartedAt() !== null) {
			clearImageGenIndicator();
		}
	});
	onCleanup(() => {
		if (nowTimer !== undefined) clearInterval(nowTimer);
	});

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

	// Wake-word fires while the assistant is mid-response should cancel
	// what's in progress (TTS audio + the in-flight LLM stream) so the
	// user can immediately ask their new question. tts.cancel() drains
	// the audio queue; abortCtrl.abort() trips the fetch in send() which
	// flips streaming() back to false via its catch block. The recognizer
	// then starts cleanly on top.
	const interruptVoice = () => {
		tts.cancel();
		abortCtrl?.abort();
	};

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
		tts.cancel();
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
					// First post-approval token from the AI's reply — the
					// image must already be persisted, so the "generating
					// image…" banner has served its purpose.
					clearImageGenIndicator();
					const delta = data.delta as string;
					appendDelta(delta);
				} else if (event === "audio_chunk") {
					// MCP synthesized a chunk on the voice service and
					// forwarded it to us as base64. Decode and queue for
					// gapless playback.
					try {
						const b64 = String((data as { data?: string }).data ?? "");
						console.log(
							`[voice] audio_chunk event received: ${b64.length} base64 chars`,
						);
						const bin = atob(b64);
						const arr = new Uint8Array(bin.length);
						for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
						tts.enqueueAudioBytes(arr.buffer);
					} catch (e) {
						console.error("[voice] audio_chunk decode failed", e);
					}
				} else if (event === "voice_debug") {
					if (
						typeof localStorage !== "undefined" &&
						localStorage.getItem("voiceDebug") === "1"
					) {
						console.log("[voice/server]", data);
					}
				} else if (event === "tool_use_start") {
					clearImageGenIndicator();
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
					tts.cancel();
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
		// TEMPORARY guard until chat is decoupled from nooks: today the MCP
		// route is /nooks/:nookId/chat, so an empty contextNookId would POST
		// to /nooks//chat and 404 silently. The VAD recognizer can fire
		// from contexts where no nook is selected (e.g. the global chat
		// panel mounted in App.tsx), so we have to catch that here. Remove
		// this once the chat route is moved off the nook URL.
		if (!props.contextNookId) {
			setError("Open a nook to chat — the chat is still nook-scoped for now.");
			return;
		}
		setModel(selectedModel);
		setQuickReplyDismissed(false);
		// AudioContext.resume() only honors a recent user gesture; chunks
		// arrive seconds later, so we have to wake the context *here*, while
		// we still have the click in scope. No-op after the first call.
		if (voiceMode()) tts.prime();
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
						voice_mode: voiceMode(),
						voice_lang: voiceLang(),
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
		// Prime the AudioContext from this approval click (user gesture)
		// so chunks arriving later can actually play.
		if (voiceMode()) tts.prime();

		// If any of the approved tools is generate_image, start the
		// "Generating image…" indicator — the wait is long enough
		// (20–60s with OpenAI) that a generic spinner doesn't tell
		// the user anything useful about what's happening.
		if (approved && pa.tools.some((t) => t.name === "generate_image")) {
			startImageGenIndicator();
		}

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
						voice_mode: voiceMode(),
						voice_lang: voiceLang(),
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

	// ── voice consent (kiosk hands-free approval) ────────────
	// When the approval modal opens in voice mode, TTS the short prompt
	// ("I want to update a note. Should I?") and listen for one
	// utterance. Loose yes/no matching across EN+DE; ambiguous → re-ask
	// once, then deny. The manual Approve/Deny buttons remain active in
	// parallel so the user can override with a click if they prefer.
	createEffect(() => {
		const pa = pendingApproval();
		if (!pa) return;
		if (!voiceMode()) return;
		let aborted = false;
		void (async () => {
			try {
				const lang = voiceLang() || "en";
				const prompt = buildConsentPrompt(pa.tools);
				let transcript = await awaitVoiceConsent({ prompt, lang });
				if (aborted) return;
				let decision = matchConsent(transcript);
				if (decision === "ambiguous") {
					transcript = await awaitVoiceConsent({
						prompt: "Sorry, please say yes or no.",
						lang,
					});
					if (aborted) return;
					decision = matchConsent(transcript);
				}
				if (aborted) return;
				void submitToolResults(decision === "approve");
			} catch (e) {
				// TTS / mic / network error — fall back to the manual modal.
				console.warn("[voice consent] falling back to manual modal:", e);
			}
		})();
		onCleanup(() => {
			aborted = true;
		});
	});

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
							<div class={styles.listHeader}>
								<span class={styles.listSectionTitle}>Recent</span>
								<div class={styles.listHeaderActions}>
									<button
										type="button"
										class={styles.listAction}
										onClick={onExport}
										title="Download all conversations as a zip"
									>
										Export
									</button>
									<button
										type="button"
										class={styles.listActionDanger}
										onClick={() => void onDeleteAll()}
										title="Delete every conversation"
									>
										Delete all
									</button>
								</div>
							</div>
							<div class={styles.listSection}>
								<For each={conversations() ?? []}>
									{(conv) => (
										<div class={styles.convItemRow}>
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
											<button
												type="button"
												class={styles.convDelete}
												onClick={(e) => void onDeleteConv(conv, e)}
												title="Delete this conversation"
												aria-label="Delete conversation"
											>
												×
											</button>
										</div>
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
						voiceMode={voiceMode()}
						onVoiceModeChange={setVoiceMode}
						voiceLang={voiceLang()}
						onVoiceLangChange={setVoiceLang}
						voiceStatus={voiceStatus()}
						onInterruptVoice={interruptVoice}
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
					<Show when={streaming() && imageGenStartedAt() === null}>
						<div class={styles.thinkingBar} />
					</Show>
					<Show when={imageGenStartedAt() !== null}>
						<div
							style={{
								display: "flex",
								"align-items": "center",
								gap: "8px",
								padding: "8px 10px",
								"font-size": "0.8125rem",
								color: "var(--color-text-secondary)",
								background: "var(--color-primary-bg, #eff6ff)",
								border: "1px solid var(--color-primary-border, #bae6fd)",
								"border-radius": "6px",
								"margin-bottom": "6px",
							}}
						>
							<span class={styles.toolSpinner} aria-hidden="true" />
							<span>Generating image…</span>
							<span
								style={{
									"margin-left": "auto",
									"font-variant-numeric": "tabular-nums",
									color: "var(--color-text-muted)",
								}}
							>
								{(() => {
									const started = imageGenStartedAt();
									if (started === null) return "";
									const sec = Math.floor((nowMs() - started) / 1000);
									return `${sec}s`;
								})()}
							</span>
						</div>
					</Show>
					<Show when={streaming()}>
						<button
							type="button"
							onClick={() => {
								abortCtrl?.abort();
								tts.cancel();
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
						voiceMode={voiceMode()}
						onVoiceModeChange={setVoiceMode}
						voiceLang={voiceLang()}
						onVoiceLangChange={setVoiceLang}
						voiceStatus={voiceStatus()}
						onInterruptVoice={interruptVoice}
						contextUsage={contextUsage()}
					/>
				</div>
			</Show>
		</div>
	);
}
