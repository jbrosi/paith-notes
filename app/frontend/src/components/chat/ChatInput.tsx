import { createSignal, Show } from "solid-js";
import { useFeatures } from "../../features";
import styles from "./ChatInput.module.css";
import { createRecognizer, isSttSupported, isTtsSupported } from "./voice";

const MODELS = [
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-opus-4-6", label: "Opus 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

type ContextUsage = { ratio: number; level: "" | "warning" | "critical" };

// Voice is multilingual end-to-end: Whisper auto-detects the input
// language, Claude replies in the same language, and the TTS engine
// (Kokoro for local, gpt-4o-mini-tts for OpenAI) speaks it. The
// voice_lang request field defaults to "en"; no lang picker surfaced.

type Props = {
	onSend: (text: string, model: string) => void;
	disabled: boolean;
	model: string;
	onModelChange: (model: string) => void;
	inputRef?: (el: HTMLTextAreaElement) => void;
	voiceMode?: boolean;
	onVoiceModeChange?: (v: boolean) => void;
	voiceLang?: string;
	onVoiceLangChange?: (lang: string) => void;
	// "thinking" while the LLM is generating but no audio has played
	// yet; "speaking" once TTS playback starts. Idle outside voice mode
	// and between turns. Drives the status line above the textarea so
	// the kiosk user has feedback during the gap between transcript and
	// first audio chunk.
	voiceStatus?: "idle" | "thinking" | "speaking";
	contextUsage?: ContextUsage;
};

export function ChatInput(props: Props) {
	const [text, setText] = createSignal("");
	const [voiceError, setVoiceError] = createSignal<string | null>(null);
	const features = useFeatures();
	const sttSupported = () => features().voice && isSttSupported();
	const ttsSupported = () => features().voice && isTtsSupported();
	const voiceCapable = () => sttSupported() || ttsSupported();

	const recognizer = isSttSupported()
		? createRecognizer({
				onFinal: (transcript) => {
					if (props.disabled) return;
					// Voice-mode guidance lives in the MCP system prompt now (it's
					// conditional on the `voice_mode` flag in the request body),
					// so we just send the user's words verbatim. Keeping the
					// transcript clean also makes saved conversations readable.
					props.onSend(transcript, props.model);
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
		if (!t || props.disabled) return;
		recognizer?.stop();
		props.onSend(t, props.model);
		setText("");
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
		return "";
	};
	const statusVisible = () => statusText() !== "";

	return (
		<div class={styles.form}>
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
			<div class={styles.row}>
				<textarea
					class={styles.textarea}
					value={text()}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={onKeyDown}
					disabled={props.disabled}
					placeholder="Ask about your notes… (Enter to send)"
					rows={1}
					ref={props.inputRef}
				/>
				<Show when={sttSupported()}>
					<button
						class={`${styles.micBtn} ${recognizer?.isListening() ? styles.micBtnActive : ""}`}
						type="button"
						onClick={toggleMic}
						disabled={props.disabled}
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
					disabled={props.disabled || text().trim() === ""}
				>
					Send
				</button>
			</div>
			<div class={styles.controls}>
				<select
					class={styles.modelSelect}
					value={props.model}
					onChange={(e) => props.onModelChange(e.currentTarget.value)}
					disabled={props.disabled}
				>
					{MODELS.map((m) => (
						<option value={m.value}>{m.label}</option>
					))}
				</select>
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
						return (
							<div
								class={styles.contextIndicator}
								title={`Context window: ${pct()}% used`}
							>
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
								<span style={{ color: color() }}>{pct()}%</span>
							</div>
						);
					})()}
				</Show>
			</div>
		</div>
	);
}
