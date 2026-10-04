import {
	createEffect,
	createSignal,
	For,
	lazy,
	onCleanup,
	Show,
} from "solid-js";
import { useFeatures } from "../../features";
import styles from "./ChatInput.module.css";
import type { ContextBreakdown } from "./ChatMessage";
import {
	type AttachedImage,
	extractImageBlobs,
	processImageAttachment,
} from "./imageAttach";
import { createRecognizer, isSttSupported, isTtsSupported } from "./voice";
import { createWakeListener, isWakeSupported } from "./wake";

// Lazy-load the enrollment modal so its CSS + MediaRecorder logic
// don't ship in the initial chat bundle. The modal is rare-use
// (users open it once or twice ever).
const VoiceEnrollment = lazy(() =>
	import("./VoiceEnrollment").then((m) => ({ default: m.VoiceEnrollment })),
);

// Wake-word sidecar config. Empty URL → no hands-free, voice mode stays
// push-to-talk-only (the default for non-kiosk deployments). When set,
// the sidecar must be on the SAME machine as the browser; the URL is
// typically ws://localhost:8889/listen. See app/wake/ for the sidecar.
const WAKE_URL = (
	(import.meta.env.VITE_WAKE_WORD_URL as string | undefined) ?? ""
).trim();
// Display label shown in the kiosk's "Say <X> to start" prompt. Doesn't
// have to match the openWakeWord model name exactly — pick whatever
// matches what users actually say. e.g. model="alexa", label="Alexa".
const WAKE_LABEL = (
	(import.meta.env.VITE_WAKE_WORD_LABEL as string | undefined) ??
	"the wake word"
).trim();
const WAKE_AVAILABLE = WAKE_URL !== "" && isWakeSupported();

// Model names are the real backend names (proxied through LiteLLM to local
// models when ANTHROPIC_BASE_URL is set). The UI shows the human label;
// the value is what gets sent to MCP and stored on the conversation.
// `vision` marks models that can accept image input (paith-low is text-only,
// its Ollama build has no mmproj). Shown as a badge so the user knows which
// model will actually look at attached images.
export const MODELS = [
	{ value: "paith-low", label: "Paith Low", vision: false },
	{ value: "paith-high", label: "Paith High", vision: true },
];

export const MODEL_SUPPORTS_VISION = new Set(
	MODELS.filter((m) => m.vision).map((m) => m.value),
);

// Extended-thinking levels the chat backend supports. "off" is the
// default (no thinking). Local qwen backends advertise a "thinking"
// capability; low/high map to a small vs. generous reasoning budget on
// the MCP side.
const THINKING_LEVELS = [
	{ value: "off", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "high", label: "High" },
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]["value"];

type ContextUsage = {
	ratio: number;
	level: "" | "warning" | "critical";
	tokens?: number;
	limit?: number;
	approx?: boolean;
	breakdown?: ContextBreakdown;
};
const fmtCtxTokens = (n: number) =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// Voice is multilingual end-to-end: Whisper auto-detects the input
// language, Claude replies in the same language, and the TTS engine
// (Kokoro for local, gpt-4o-mini-tts for OpenAI) speaks it. The
// voice_lang request field defaults to "en"; no lang picker surfaced.

// Extra context the voice path picks up alongside the transcript —
// the identified speaker, the language/duration Whisper reported.
// Optional; manual-text submissions don't supply it. Plumbed through
// to ChatPanel.send → MCP request body so the system prompt can
// address the user by name when known. Also surfaces in the chat UI
// debug overlay (when debugMode is on).
export type SendMeta = {
	speaker?: string | null;
	speakerConfidence?: number;
	language?: string;
	durationSec?: number;
	/** Attached images. Only `original` is uploaded (MCP resizes for vision and
	 *  saves full-res); `preview` renders the local thumbnail. */
	images?: AttachedImage[];
};

type Props = {
	onSend: (text: string, model: string, meta?: SendMeta) => void;
	/**
	 * Hard lock — textarea, mic, send, model select ALL disabled.
	 * Reserved for absolute-lockout states (rare). For "AI is generating"
	 * use `busy` instead so the user can still draft their next message
	 * while waiting.
	 */
	disabled: boolean;
	/**
	 * Soft lock — AI is working (streaming, reconnecting, or waiting on
	 * tool approval). Textarea stays usable so the user can compose the
	 * next message; only Send + mic + model-switch are blocked to avoid
	 * racing an in-flight turn.
	 */
	busy?: boolean;
	model: string;
	onModelChange: (model: string) => void;
	thinking?: ThinkingLevel;
	onThinkingChange?: (v: ThinkingLevel) => void;
	inputRef?: (el: HTMLTextAreaElement) => void;
	voiceMode?: boolean;
	onVoiceModeChange?: (v: boolean) => void;
	voiceLang?: string;
	onVoiceLangChange?: (lang: string) => void;
	// "thinking" while the LLM is generating but no audio has played
	// yet; "speaking" once TTS playback starts; "consent" while a
	// voice-handled tool-approval modal is taking the mic via its own
	// transient recognizer. Drives the status line above the textarea
	// and gates the wake listener so multiple voice paths can't fight
	// for the microphone.
	voiceStatus?: "idle" | "thinking" | "speaking" | "consent";
	// Called when the wake word fires while the assistant is mid-turn
	// (thinking or speaking). Cancels TTS playback + aborts the in-flight
	// LLM stream so the user's new utterance gets a clean slate.
	onInterruptVoice?: () => void;
	contextUsage?: ContextUsage;
};

export function ChatInput(props: Props) {
	const [text, setText] = createSignal("");
	const [voiceError, setVoiceError] = createSignal<string | null>(null);
	const [enrollmentOpen, setEnrollmentOpen] = createSignal(false);
	const [attachments, setAttachments] = createSignal<AttachedImage[]>([]);
	const [processing, setProcessing] = createSignal(false);
	const fileInputRef = () => document.getElementById("chat-image-file");

	async function addImageBlobs(blobs: Blob[]) {
		if (blobs.length === 0 || props.disabled) return;
		setProcessing(true);
		try {
			const fresh = await Promise.all(
				blobs.slice(0, 4).map((b) => processImageAttachment(b)),
			);
			setAttachments((prev) => [...prev, ...fresh].slice(0, 4));
		} catch (err) {
			setVoiceError(
				err instanceof Error ? err.message : "Could not read image",
			);
		} finally {
			setProcessing(false);
		}
	}

	function removeAttachment(index: number) {
		setAttachments((prev) => prev.filter((_, i) => i !== index));
	}
	const features = useFeatures();
	const sttSupported = () => features().voice && isSttSupported();
	const ttsSupported = () => features().voice && isTtsSupported();
	const voiceCapable = () => sttSupported() || ttsSupported();

	const recognizer = isSttSupported()
		? createRecognizer({
				onFinal: (transcript, meta) => {
					if (props.disabled) return;
					// Voice-mode guidance lives in the MCP system prompt now (it's
					// conditional on the `voice_mode` flag in the request body),
					// so we just send the user's words verbatim. Keeping the
					// transcript clean also makes saved conversations readable.
					// The optional meta.speaker rides along so MCP's system
					// prompt can personalize when the voice container has
					// identified an enrolled speaker.
					props.onSend(transcript, props.model, {
						speaker: meta?.speaker ?? null,
						speakerConfidence: meta?.speakerConfidence,
						language: meta?.language,
						durationSec: meta?.durationSec,
					});
				},
				onError: (msg) => setVoiceError(msg),
				// No `language` here — the server runs a constrained
				// autodetect over WHISPER_LANGUAGE_CANDIDATES (default
				// en,de), which is more reliable on short clips than
				// either pinning or full 99-lang autodetect.
			})
		: null;

	const submit = () => {
		const t = text().trim();
		const imgs = attachments();
		if ((!t && imgs.length === 0) || props.disabled || props.busy) return;
		recognizer?.stop();
		props.onSend(t, props.model, { images: imgs.length ? imgs : undefined });
		setText("");
		setAttachments([]);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};

	const toggleMic = () => {
		setVoiceError(null);
		if (!recognizer) return;
		if (recognizer.isListening()) {
			recognizer.stop();
		} else {
			void recognizer.start();
		}
	};

	// Wake-word lifecycle. Sequential mic ownership: wake holds the mic
	// while idle, releases on wake fire so the VAD recognizer can take
	// over, then re-takes the mic once recording + TTS playback finish.
	// Gated on voice mode being on AND no other voice phase running.
	// Echo cancellation in getUserMedia keeps the assistant's own TTS
	// from re-triggering, but we also pause wake during "speaking" as
	// belt-and-suspenders for noisy speakers.
	let wakeListener: ReturnType<typeof createWakeListener> | null = null;
	const tearDownWake = () => {
		if (wakeListener) {
			wakeListener.stop();
			wakeListener = null;
		}
	};
	const [wakeActive, setWakeActive] = createSignal(false);
	if (WAKE_AVAILABLE) {
		createEffect(() => {
			// Wake is active whenever voice mode is on AND the recognizer
			// isn't currently holding the mic for VAD AND the consent
			// flow isn't running (consent has its own transient recognizer
			// — two recognizers fighting for the mic deadlocks). We
			// deliberately do NOT gate on thinking/speaking — the user
			// should be able to say "Alexa" mid-reply to interrupt; the
			// onWake handler then cancels what's in progress via
			// onInterruptVoice.
			const wantWake =
				(props.voiceMode ?? false) &&
				!recognizer?.isListening() &&
				(props.voiceStatus ?? "idle") !== "consent";
			if (wantWake && !wakeListener) {
				wakeListener = createWakeListener({
					url: WAKE_URL,
					onWake: () => {
						// Hand the mic off from wake to VAD. The recognizer
						// acquires getUserMedia itself, so we must tear down
						// the wake stream first or both will fight for the mic.
						tearDownWake();
						setWakeActive(false);
						// Cancel any in-flight TTS + LLM stream so the new
						// utterance starts on a clean slate. Safe to call
						// when nothing's in progress (no-ops).
						props.onInterruptVoice?.();
						void recognizer?.start();
					},
					onError: (msg) => {
						setVoiceError(msg);
						setWakeActive(false);
					},
				});
				void wakeListener.start();
				setWakeActive(true);
			} else if (!wantWake && wakeListener) {
				tearDownWake();
				setWakeActive(false);
			}
		});
		onCleanup(tearDownWake);
	}

	// Single status line above the textarea. Priority:
	//   1. Any non-empty recognizer interim — covers "Waiting…",
	//      "Listening…", and the post-VAD "Thinking…" that the recognizer
	//      keeps set while /stt is in flight. Checking interim *before*
	//      isListening closes the brief gap after onSpeechEnd where
	//      isListening flips false but the upload is still mid-air.
	//   2. ChatPanel-supplied voiceStatus — covers the LLM-streaming
	//      ("Thinking…") and TTS-playing ("Speaking…") phases that the
	//      recognizer doesn't know about.
	const statusText = (): string => {
		const interim = recognizer?.interim() ?? "";
		if (interim) return interim;
		const s = props.voiceStatus ?? "idle";
		if (s === "thinking") return "Thinking…";
		if (s === "speaking") return "Speaking…";
		// Kiosk-friendly wake prompt only when nothing else is happening.
		if (wakeActive()) return `Say "${WAKE_LABEL}" to start…`;
		return "";
	};
	const statusVisible = () => statusText() !== "";

	return (
		<div class={styles.form}>
			<Show when={attachments().length > 0 || processing()}>
				<div class={styles.attachRow}>
					<For each={attachments()}>
						{(a, i) => (
							<div class={styles.attachThumb}>
								<img src={a.preview} alt={a.filename} />
								<button
									type="button"
									class={styles.attachRemove}
									onClick={() => removeAttachment(i())}
									aria-label={`Remove ${a.filename}`}
								>
									✕
								</button>
							</div>
						)}
					</For>
					<Show when={processing()}>
						<div class={styles.attachThumb}>
							<span class={styles.attachLoading} />
						</div>
					</Show>
				</div>
			</Show>
			<Show when={statusVisible()}>
				<div class={styles.interim} aria-live="polite">
					<Show when={recognizer?.isListening()}>
						<span class={styles.micPulse} aria-hidden="true" />
					</Show>
					{statusText()}
				</div>
			</Show>
			<Show when={voiceError() !== null}>
				<div class={styles.voiceError} role="alert">
					{voiceError()}
				</div>
			</Show>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a pointer interaction; the attach button is the accessible path */}
			<div
				class={styles.row}
				onDragOver={(e) => {
					if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
				}}
				onDrop={(e) => {
					if (!e.dataTransfer) return;
					e.preventDefault();
					void addImageBlobs(extractImageBlobs(e.dataTransfer.items));
				}}
			>
				<input
					id="chat-image-file"
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple
					class={styles.hiddenFileInput}
					style={{ display: "none" }}
					onChange={(e) => {
						const files = Array.from(e.currentTarget.files ?? []);
						e.currentTarget.value = "";
						void addImageBlobs(
							files.filter((f) => f.type.startsWith("image/")),
						);
					}}
				/>
				<button
					type="button"
					class={styles.attachBtn}
					onClick={() => fileInputRef()?.click()}
					disabled={props.disabled}
					title="Attach an image (PNG keeps transparency). It's sent to the model for vision and can be saved as a note."
					aria-label="Attach image"
				>
					📎
				</button>
				<textarea
					class={styles.textarea}
					value={text()}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={onKeyDown}
					onPaste={(e) => {
						const blobs = extractImageBlobs(e.clipboardData?.items);
						if (blobs.length > 0) {
							e.preventDefault();
							void addImageBlobs(blobs);
						}
					}}
					disabled={props.disabled}
					placeholder={
						props.busy
							? "Draft your next message… (send unlocks when the AI finishes)"
							: "Ask about your notes… (Enter to send)"
					}
					rows={1}
					ref={props.inputRef}
				/>
				<Show when={sttSupported()}>
					<button
						class={`${styles.micBtn} ${recognizer?.isListening() ? styles.micBtnActive : ""}`}
						type="button"
						onClick={toggleMic}
						disabled={props.disabled || props.busy}
						title={
							recognizer?.isListening()
								? "Cancel recording — recording auto-submits when you pause"
								: "Voice input"
						}
						aria-label={
							recognizer?.isListening()
								? "Cancel recording"
								: "Start voice input"
						}
					>
						{recognizer?.isListening() ? "✕" : "🎤"}
					</button>
				</Show>
				<button
					class={styles.sendBtn}
					type="button"
					onClick={submit}
					disabled={
						props.disabled ||
						props.busy ||
						(text().trim() === "" && attachments().length === 0)
					}
				>
					Send
				</button>
			</div>
			<div class={styles.controls}>
				<select
					class={styles.modelSelect}
					value={props.model}
					onChange={(e) => {
						const v = e.currentTarget.value;
						sessionStorage.setItem("paith-model", v);
						props.onModelChange(v);
					}}
					disabled={props.disabled || props.busy}
				>
					{MODELS.map((m) => (
						<option value={m.value}>
							{m.label}
							{m.vision ? " · 👁" : ""}
						</option>
					))}
				</select>
				<Show when={props.onThinkingChange}>
					{(onThinkingChange) => (
						<select
							class={styles.thinkingSelect}
							value={props.thinking ?? "off"}
							onChange={(e) =>
								onThinkingChange()(e.currentTarget.value as ThinkingLevel)
							}
							disabled={props.disabled || props.busy}
							title="Extended thinking — how much reasoning the model spends before answering"
						>
							{THINKING_LEVELS.map((t) => (
								<option value={t.value}>Thinking: {t.label}</option>
							))}
						</select>
					)}
				</Show>
				<Show when={voiceCapable() && props.onVoiceModeChange}>
					<label
						class={styles.voiceToggle}
						title={
							ttsSupported()
								? "When on, the assistant's replies are spoken aloud and kept short."
								: "Speech output is not supported in this browser."
						}
					>
						<input
							type="checkbox"
							checked={props.voiceMode ?? false}
							disabled={!ttsSupported()}
							onChange={(e) =>
								props.onVoiceModeChange?.(e.currentTarget.checked)
							}
						/>
						<span>Voice mode</span>
					</label>
					<button
						type="button"
						class={styles.voiceProfilesBtn}
						onClick={() => setEnrollmentOpen(true)}
						title="Manage voice profiles (enroll yourself so the assistant can identify you by voice)"
					>
						🎙️ Profiles
					</button>
				</Show>
				<Show when={(props.contextUsage?.ratio ?? 0) > 0}>
					{(() => {
						const usage = () => props.contextUsage ?? { ratio: 0, level: "" };
						const pct = () => Math.round(usage().ratio * 100);
						const color = () =>
							usage().ratio > 0.9
								? "var(--color-danger, #ef4444)"
								: usage().ratio > 0.5
									? "var(--color-warning, #f59e0b)"
									: "var(--color-text-faint, #ccc)";
						const circumference = 50.27;
						const offset = () => circumference * (1 - usage().ratio);
						// Absolute "<used>/<limit>" label + tooltip. `~` marks a pre-send
						// estimate for a reopened conversation; it snaps to the exact
						// count after the first message.
						const approxMark = () => (usage().approx ? "~" : "");
						const tokenLabel = () => {
							const u = usage();
							if (u.tokens == null || u.limit == null) return null;
							return `${approxMark()}${fmtCtxTokens(u.tokens)}/${fmtCtxTokens(u.limit)}`;
						};
						const title = () => {
							const u = usage();
							const base =
								u.tokens != null && u.limit != null
									? `Context window: ${approxMark()}${fmtCtxTokens(u.tokens)} / ${fmtCtxTokens(u.limit)} tokens (${pct()}%)`
									: `Context window: ${pct()}% used`;
							let out = u.approx
								? `${base} — estimated until your next message`
								: base;
							// Per-component breakdown (only present when the MCP
							// server has CHAT_DEBUG_CONTEXT on). Shows exactly
							// where the window is going: system prompt, tool
							// schemas, and the top conversation contributors.
							const b = u.breakdown;
							if (b) {
								out += `\n\nBreakdown (server-side, backend tokenizer):`;
								out += `\n  system:  ${fmtCtxTokens(b.system_tokens)}`;
								out += `\n  tools:   ${fmtCtxTokens(b.tools_tokens)}  (${(b.messages?.length ?? 0) + 2} components)`;
								out += `\n  total:   ${fmtCtxTokens(b.total_tokens)}`;
								if (b.biggest?.length) {
									out += `\n\nTop contributors:`;
									for (const c of b.biggest) {
										out += `\n  ${fmtCtxTokens(c.tokens).padStart(6)}  ${c.label}`;
									}
								}
							}
							return out;
						};
						return (
							<div class={styles.contextIndicator} title={title()}>
								<svg
									width="14"
									height="14"
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
								<span style={{ color: color() }}>
									{tokenLabel() ?? `${pct()}%`}
								</span>
							</div>
						);
					})()}
				</Show>
			</div>
			<Show when={enrollmentOpen()}>
				<VoiceEnrollment onClose={() => setEnrollmentOpen(false)} />
			</Show>
		</div>
	);
}
