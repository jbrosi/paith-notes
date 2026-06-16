import { createSignal, Show } from "solid-js";
import styles from "./ChatInput.module.css";
import {
	createRecognizer,
	isSttSupported,
	isTtsSupported,
	voiceModeInstruction,
} from "./voice";

const MODELS = [
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-opus-4-6", label: "Opus 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

type ContextUsage = { ratio: number; level: "" | "warning" | "critical" };

// Languages exposed in the picker. The backend supports more (Kokoro covers
// es/fr/hi/it/ja/pt-br/zh; Piper auto-downloads nl/pl/pt/ru/sv/tr/uk on first
// use) — start with the two we actually use and extend when needed.
// Voice mode is currently locked to Kokoro English — the dropdown and
// non-EN options are commented out until we re-validate the other engines
// (Chatterbox / F5-DE). The model is instructed to translate any input to
// English in voice mode so a single hardcoded lang is enough.
// const VOICE_LANGS = [
// 	{ value: "en", label: "EN" },
// 	{ value: "de", label: "DE" },
// 	{ value: "en-cb", label: "EN (Chatterbox)" },
// 	{ value: "en-f5", label: "EN (F5-TTS)" },
// 	{ value: "de-f5", label: "DE (F5-TTS)" },
// ];

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
	contextUsage?: ContextUsage;
};

export function ChatInput(props: Props) {
	const [text, setText] = createSignal("");
	const [voiceError, setVoiceError] = createSignal<string | null>(null);
	const sttSupported = isSttSupported();
	const ttsSupported = isTtsSupported();
	const voiceCapable = sttSupported || ttsSupported;

	const recognizer = sttSupported
		? createRecognizer({
				onFinal: (transcript) => {
					if (props.disabled) return;
					// Voice mode toggle gates whether the assistant *speaks*; for the
					// user side, a voice-mode hint is prepended so the model answers
					// in a speakable shape (and in the user's selected output lang).
					// Hardcoded "en" — voice mode is locked to Kokoro English until
					// we re-enable the lang dropdown above.
					const payload = props.voiceMode
						? `${voiceModeInstruction("en")}\n\n${transcript}`
						: transcript;
					props.onSend(payload, props.model);
				},
				onError: (msg) => setVoiceError(msg),
			})
		: null;

	const submit = () => {
		const t = text().trim();
		if (!t || props.disabled) return;
		recognizer?.stop();
		const payload = props.voiceMode
			? `${voiceModeInstruction("en")}\n\n${t}`
			: t;
		props.onSend(payload, props.model);
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

	return (
		<div class={styles.form}>
			<Show when={recognizer?.isListening()}>
				<div class={styles.interim} aria-live="polite">
					<span class={styles.micPulse} aria-hidden="true" />
					{recognizer?.interim() || "Listening…"}
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
				<Show when={sttSupported}>
					<button
						class={`${styles.micBtn} ${recognizer?.isListening() ? styles.micBtnActive : ""}`}
						type="button"
						onClick={toggleMic}
						disabled={props.disabled}
						title={
							recognizer?.isListening()
								? "Stop listening and send"
								: "Voice input"
						}
						aria-label={
							recognizer?.isListening()
								? "Stop listening and send"
								: "Start voice input"
						}
					>
						{recognizer?.isListening() ? "■" : "🎤"}
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
				<Show when={voiceCapable && props.onVoiceModeChange}>
					<label
						class={styles.voiceToggle}
						title={
							ttsSupported
								? "When on, the assistant's replies are spoken aloud and kept short."
								: "Speech output is not supported in this browser."
						}
					>
						<input
							type="checkbox"
							checked={props.voiceMode ?? false}
							disabled={!ttsSupported}
							onChange={(e) =>
								props.onVoiceModeChange?.(e.currentTarget.checked)
							}
						/>
						<span>Voice mode</span>
					</label>
				</Show>
				{/*
				Voice language picker — temporarily hidden. Voice mode is locked
				to Kokoro English on the local container; the model is told to
				translate any input into English (see voiceModeInstruction). Bring
				this back together with the VOICE_LANGS array at the top once the
				other engines (Chatterbox / F5-DE) are wired and stable again.
				<Show when={voiceCapable && props.onVoiceLangChange}>
					<select
						class={styles.voiceLang}
						value={props.voiceLang ?? "en"}
						onChange={(e) => props.onVoiceLangChange?.(e.currentTarget.value)}
						disabled={props.disabled}
						title="Voice language (used for both mic transcription and spoken replies)"
					>
						{VOICE_LANGS.map((l) => (
							<option value={l.value}>{l.label}</option>
						))}
					</select>
				</Show>
				*/}
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
