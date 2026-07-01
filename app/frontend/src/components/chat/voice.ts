import { MicVAD, utils as vadUtils } from "@ricky0123/vad-web";
import { createSignal, onCleanup } from "solid-js";

// Backend voice service for the mic upload. TTS no longer goes through a
// per-sentence fetch from the frontend — MCP synthesizes server-side and
// streams audio chunks on the chat SSE.
const STT_ENDPOINT = "/api/voice/stt";

export function isSttSupported(): boolean {
	// The recognizer needs getUserMedia, AudioWorklet (for the VAD's
	// processor node), and WebAssembly (for the Silero ONNX model).
	return (
		typeof window !== "undefined" &&
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof AudioWorkletNode !== "undefined" &&
		typeof WebAssembly !== "undefined"
	);
}

export function isTtsSupported(): boolean {
	// TTS goes through the backend and plays via <audio>, which is universal.
	return typeof window !== "undefined" && typeof Audio !== "undefined";
}

export type RecognizerMeta = {
	/** Speaker name when identified, null when no match (or no enrolled
	 *  voices). Only set when the voice container's /stt response
	 *  includes a `speaker` field — silently absent otherwise. */
	speaker?: string | null;
	speakerConfidence?: number;
	/** Whisper-reported language code (autodetect, or pinned). */
	language?: string;
	/** Audio clip length in seconds (Whisper-reported). */
	durationSec?: number;
};

type RecognizerOptions = {
	onFinal: (text: string, meta?: RecognizerMeta) => void;
	onError?: (msg: string) => void;
	/**
	 * BCP-47-ish short code passed to Whisper as a hard language hint.
	 * Whisper's autodetect is unreliable on the short (~2-3s) clips that
	 * Silero VAD produces — it often falls back to Arabic for English
	 * utterances. Pinning the language fixes that. Defaults to "en".
	 */
	language?: () => string;
};

/**
 * Tap-to-record recognizer backed by Silero VAD (browser-side) and the
 * /stt endpoint. The VAD endpoints the utterance automatically — speech
 * starts the capture, ~1 second of silence ends it and triggers the
 * upload. The user never taps "stop" in the normal path; tapping the mic
 * during a recording cancels it instead. Silero is fully on-device (ONNX
 * via onnxruntime-web), so no audio leaves the page until the explicit
 * POST.
 *
 * The exposed API (isListening, interim, start, stop) mirrors the
 * previous MediaRecorder-based recognizer so ChatInput needs no changes.
 * `interim` doubles as a status line ("Listening for speech…" →
 * "Listening…" → "Transcribing…") since Whisper still runs as a single
 * batch transcription after the upload.
 */
export function createRecognizer(opts: RecognizerOptions) {
	const [isListening, setListening] = createSignal(false);
	const [interim, setInterim] = createSignal("");
	let vad: MicVAD | null = null;
	// Flipped by stop() so an in-flight onSpeechEnd drops the audio
	// instead of POSTing after the user cancelled.
	let cancelled = false;

	const teardown = async () => {
		if (vad) {
			const v = vad;
			vad = null;
			try {
				await v.destroy();
			} catch {
				// already torn down — destroy() is idempotent enough
			}
		}
		setListening(false);
		setInterim("");
	};

	const start = async () => {
		if (vad) return;
		cancelled = false;
		// Status progression:
		//   "Waiting…"  — mic open, VAD running, no speech detected yet
		//   "Listening…" — VAD picked up speech, currently capturing
		//   "Thinking…" — VAD ended, /stt + LLM in flight
		// (then ChatPanel's voiceStatus takes over with Thinking/Speaking)
		setInterim("Waiting…");
		try {
			vad = await MicVAD.new({
				// v5 is the newer Silero model — higher accuracy at the cost
				// of slightly more CPU. Both run easily on a phone.
				model: "v5",
				// Asset paths populated by scripts/copy-vad-assets.mjs at
				// dev/build time; served from public/ with correct MIME by
				// Vite's built-in handler (see vite.config.js for the
				// query-strip middleware that keeps import-analysis off
				// these URLs).
				baseAssetPath: "/vad/",
				onnxWASMBasePath: "/onnx/",
				// Endpointing thresholds:
				// - redemptionMs=1500 — wait 1.5s after speech drops below
				//   the negative threshold before declaring end. Default
				//   (~750ms) cuts mid-sentence on natural pauses.
				// - minSpeechMs=400 — utterance must be ≥400ms to count.
				//   Default (~300ms) sometimes fires on a single loud
				//   word; 400ms weeds out coughs/chair scrapes.
				// - preSpeechPadMs=300 — keep 300ms of audio captured
				//   BEFORE the detected speech-start. Whisper transcribes
				//   noticeably worse when the first phoneme is clipped.
				redemptionMs: 1500,
				minSpeechMs: 400,
				preSpeechPadMs: 300,
				onSpeechStart: () => {
					// VAD just detected speech — switch from "Waiting…" so
					// the user gets immediate feedback that the mic actually
					// heard them. The pulse animation in ChatInput
					// reinforces the live-capture state.
					setInterim("Listening…");
				},
				onSpeechEnd: async (audio) => {
					if (cancelled) return;
					// Release the mic before transcribing — keeping it open
					// during the upload would spike battery for no reason and
					// could confuse echo cancellation if TTS replies start
					// playing before /stt returns.
					await teardown();
					// Merge "transcribing" into "thinking" — from the user's
					// perspective these are the same "waiting on the system"
					// state. ChatPanel's voiceStatus takes over once /stt
					// returns and the LLM stream starts.
					setInterim("Thinking…");
					try {
						// Silero emits 16kHz mono float32 — encodeWAV defaults
						// to PCM/16kHz/mono/16-bit, matching faster-whisper's
						// preferred input.
						const wav = vadUtils.encodeWAV(audio);
						const blob = new Blob([wav], { type: "audio/wav" });
						const result = await postForTranscript(blob, opts.language?.());
						setInterim("");
						if (result.text && !cancelled) {
							opts.onFinal(result.text, {
								speaker: result.speaker,
								speakerConfidence: result.speakerConfidence,
								language: result.language,
								durationSec: result.durationSec,
							});
						}
					} catch (err) {
						setInterim("");
						opts.onError?.(
							err instanceof Error ? err.message : "Transcription failed.",
						);
					}
				},
				onVADMisfire: () => {
					// Captured something but it was too short to count as
					// speech (a cough, a chair scrape, the tail of a wake
					// word, etc.). Drop back to "Waiting…" — the model is
					// still active, just hasn't heard a real utterance.
					setInterim("Waiting…");
				},
			});
			await vad.start();
			setListening(true);
			setInterim("Waiting…");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			opts.onError?.(
				msg.includes("denied") || msg.includes("Permission")
					? "Microphone permission denied."
					: `Could not start microphone: ${msg}`,
			);
			await teardown();
		}
	};

	const stop = () => {
		// Fire-and-forget cancel: the call sites (toggleMic, submit) don't
		// await this and they shouldn't have to. The VAD destroy is async
		// but the user-facing state flips immediately.
		if (!vad) return;
		cancelled = true;
		void teardown();
	};

	onCleanup(() => {
		cancelled = true;
		void teardown();
	});

	return { start, stop, isListening, interim };
}

// Cached AudioContext for one-shot local TTS playback (consent prompts
// etc.). Reused across calls so the first user-gesture-triggered call
// can resume() it and subsequent ones inherit the "running" state —
// browsers gate AudioContext.start on a recent user gesture.
let _speakCtx: AudioContext | null = null;

function getSpeakCtx(): AudioContext | null {
	if (_speakCtx) return _speakCtx;
	const AC: typeof AudioContext | undefined =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AC) return null;
	_speakCtx = new AC();
	return _speakCtx;
}

/**
 * Synthesize `text` via the local voice service and play it back, awaiting
 * `ended`. Used for system-spoken prompts (e.g. voice consent for tool
 * approval) where the existing chat-SSE TTS pipeline doesn't apply.
 * Always hits the local /api/voice/tts (Kokoro) — even when MCP is
 * configured to route chat TTS through OpenAI — because these are short
 * system prompts and the local path is faster + free.
 */
export async function speakLocal(text: string, lang = "en"): Promise<void> {
	const ctx = getSpeakCtx();
	if (!ctx) throw new Error("AudioContext not supported");
	if (ctx.state === "suspended") {
		try {
			await ctx.resume();
		} catch {
			/* may stay suspended without recent gesture; play will fail below */
		}
	}
	const res = await fetch("/api/voice/tts", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, lang }),
	});
	if (!res.ok) {
		throw new Error(`tts ${res.status}: ${await res.text().catch(() => "")}`);
	}
	const buf = await res.arrayBuffer();
	const audioBuf = await ctx.decodeAudioData(buf.slice(0));
	await new Promise<void>((resolve) => {
		const source = ctx.createBufferSource();
		source.buffer = audioBuf;
		source.connect(ctx.destination);
		source.onended = () => resolve();
		source.start();
	});
}

/**
 * Voice consent: speak `prompt`, capture one VAD-endpointed utterance,
 * return the transcript. Caller does the keyword matching (yes/no in
 * the language(s) it cares about) so the matcher can live near the
 * intent it's matching against. Throws on TTS/STT errors so the caller
 * can fall back to the manual modal flow.
 *
 * Used by the ChatPanel approval-modal flow when voice mode is on —
 * see the consent createEffect there.
 */
export async function awaitVoiceConsent(opts: {
	prompt: string;
	lang?: string;
	/** Hard timeout in ms (default 15s). On timeout resolves to "" so
	 *  the caller can treat silence as deny. */
	timeoutMs?: number;
}): Promise<string> {
	await speakLocal(opts.prompt, opts.lang ?? "en");
	// Capture one utterance via a transient VAD recognizer. Not the
	// ChatInput recognizer — that one's onFinal feeds the regular
	// message-submit flow, which is the opposite of what consent wants.
	const timeoutMs = opts.timeoutMs ?? 15000;
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const settle = (text: string) => {
			if (settled) return;
			settled = true;
			rec.stop();
			clearTimeout(timer);
			resolve(text);
		};
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			rec.stop();
			clearTimeout(timer);
			reject(e);
		};
		const rec = createRecognizer({
			onFinal: (text) => settle(text),
			onError: (msg) => fail(new Error(msg)),
			language: opts.lang ? () => opts.lang as string : undefined,
		});
		const timer = setTimeout(() => settle(""), timeoutMs);
		void rec.start();
	});
}

type SttResponse = {
	text: string;
	speaker?: string | null;
	speakerConfidence?: number;
	language?: string;
	durationSec?: number;
};

async function postForTranscript(
	blob: Blob,
	language: string | undefined,
): Promise<SttResponse> {
	const form = new FormData();
	form.append("audio", blob, "recording.wav");
	// Whisper's language autodetect is unreliable on the short clips
	// Silero VAD produces — it often guesses Arabic for English speech.
	// Pinning the language from the UI's voiceLang signal (defaults to
	// "en") avoids that. Empty/undefined still falls through to autodetect.
	const url = language
		? `${STT_ENDPOINT}?language=${encodeURIComponent(language)}`
		: STT_ENDPOINT;
	const res = await fetch(url, {
		method: "POST",
		credentials: "include",
		body: form,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`STT ${res.status}: ${detail || res.statusText}`);
	}
	const data = (await res.json()) as {
		text?: string;
		speaker?: string | null;
		speaker_confidence?: number;
		language?: string;
		duration?: number;
	};
	return {
		text: (data.text ?? "").trim(),
		speaker: data.speaker ?? null,
		speakerConfidence: data.speaker_confidence,
		language: data.language,
		durationSec: data.duration,
	};
}

type TtsQueueOptions = {
	// When true and `localStorage.voiceDebug === "1"`, log each enqueue with
	// timing info so the developer can see chunk arrival vs playback.
	debug?: () => boolean;
};

/**
 * Audio chunk player driven by the chat SSE stream. The MCP backend
 * sentence-splits the LLM output, calls the voice service for synthesis,
 * and forwards each resulting WAV chunk as a base64 `audio_chunk` SSE
 * event. The frontend just decodes each chunk into the same AudioContext
 * and schedules it back-to-back — strict submission order, no overlap.
 *
 * No fetching, no sentence detection, no language plumbing on this side:
 * those moved into MCP. The frontend's only job is "decode + schedule".
 */
export function createTtsQueue(_opts: TtsQueueOptions = {}) {
	const [isSpeaking, setSpeaking] = createSignal(false);
	let cancelled = false;
	let chunksReceived = 0;

	// Decoded buffers in submission order. Each enqueueAudioBytes starts a
	// decode immediately; drain awaits decodes in arrival order.
	const pending: Array<Promise<AudioBuffer | null>> = [];
	let drainPromise: Promise<void> | null = null;
	// Prebuffer: before draining the first chunk of a turn, wait for either
	// PREBUFFER_TARGET chunks to queue up or PREBUFFER_DEADLINE_MS to elapse.
	// Buys headroom so a one-word opener like "Gotcha!" doesn't drain before
	// the next sentence's chunks arrive (the synth fetch for sentence 2 only
	// fires after sentence 1's drain finishes on the MCP side, so its first
	// chunk can land 1+ seconds after sentence 1 is already playable).
	const PREBUFFER_TARGET = 3;
	const PREBUFFER_DEADLINE_MS = 1500;
	let needsPrebuffer = true;

	// One AudioContext for the whole queue's lifetime. Created on first
	// enqueue (inside a user-gesture-initiated call chain) so the browser's
	// autoplay policy lets it run.
	let ctx: AudioContext | null = null;
	// Time (in ctx.currentTime units) at which the next source should start.
	// Always >= ctx.currentTime; we let the AudioContext clock be the
	// scheduler so consecutive buffers chain sample-accurately.
	let nextStartAt = 0;
	// Live sources we may need to stop on cancel().
	const liveSources = new Set<AudioBufferSourceNode>();
	// Resolver for the currently-awaited playBuffer promise. cancel() invokes
	// it directly so drain can exit even if the AudioBufferSourceNode's
	// onended doesn't fire promptly (some browsers swallow onended on a
	// pre-start stop()). Without this, drain hangs on `await playBuffer` and
	// drainPromise never settles — subsequent chunks pile up undrained.
	let pendingPlayResolve: (() => void) | null = null;

	const ensureCtx = (): AudioContext | null => {
		if (ctx) return ctx;
		const AC: typeof AudioContext | undefined =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		// Warm-up: schedule ~400ms of silence the moment the context opens
		// so the audio sink (especially Bluetooth) is fully synced by the
		// time the first real buffer plays. Without this, BT codecs eat the
		// first 100–500ms of speech.
		const warmSec = 0.4;
		const warmBuf = ctx.createBuffer(
			1,
			Math.max(1, Math.floor(ctx.sampleRate * warmSec)),
			ctx.sampleRate,
		);
		const warmSrc = ctx.createBufferSource();
		warmSrc.buffer = warmBuf;
		warmSrc.connect(ctx.destination);
		const startAt = ctx.currentTime + 0.02;
		warmSrc.start(startAt);
		nextStartAt = startAt + warmSec;
		return ctx;
	};

	const enqueueAudioBytes = (bytes: ArrayBuffer): void => {
		if (cancelled) {
			console.warn("[voice] enqueueAudioBytes: queue cancelled, dropping");
			return;
		}
		const audioCtx = ensureCtx();
		if (!audioCtx) {
			console.warn("[voice] Web Audio not available; tts disabled");
			return;
		}
		chunksReceived++;
		const idx = chunksReceived;
		const startedAt = performance.now();
		console.log(
			`[voice] enqueue chunk #${idx}: ${bytes.byteLength} bytes, ctx.state=${audioCtx.state}`,
		);
		// decodeAudioData mutates its input in some engines — clone first.
		const promise = audioCtx
			.decodeAudioData(bytes.slice(0))
			.then((buf) => {
				console.log(
					`[voice] chunk #${idx} decoded ${buf.duration.toFixed(2)}s in ${Math.round(performance.now() - startedAt)}ms`,
				);
				return buf;
			})
			.catch((err: unknown) => {
				console.error(`[voice] chunk #${idx} decode failed`, err);
				return null;
			});
		pending.push(promise);
		void drain();
	};

	const drain = async () => {
		if (drainPromise) return drainPromise;
		drainPromise = (async () => {
			try {
				if (needsPrebuffer) {
					const deadline = performance.now() + PREBUFFER_DEADLINE_MS;
					while (
						pending.length < PREBUFFER_TARGET &&
						performance.now() < deadline &&
						!cancelled
					) {
						await new Promise<void>((r) => setTimeout(r, 50));
					}
					console.log(
						`[voice] prebuffer done: pending=${pending.length} waited=${Math.round(PREBUFFER_DEADLINE_MS - (deadline - performance.now()))}ms`,
					);
					needsPrebuffer = false;
				}
				while (pending.length > 0 && !cancelled) {
					const next = pending.shift();
					if (!next) break;
					let buf: AudioBuffer | null;
					try {
						buf = await next;
					} catch {
						continue;
					}
					if (!buf || cancelled) continue;
					await playBuffer(buf);
				}
			} finally {
				setSpeaking(false);
				// Next turn starts cold — prebuffer again.
				needsPrebuffer = true;
			}
		})();
		try {
			await drainPromise;
		} finally {
			drainPromise = null;
		}
	};

	const playBuffer = (buf: AudioBuffer): Promise<void> =>
		new Promise((resolve) => {
			const finish = () => {
				if (pendingPlayResolve === finish) pendingPlayResolve = null;
				resolve();
			};
			pendingPlayResolve = finish;
			const audioCtx = ctx;
			if (!audioCtx) {
				finish();
				return;
			}
			// Autoplay policy: if the context was created before any user
			// gesture, it may start "suspended". resume() is cheap and a
			// no-op if it's already running.
			if (audioCtx.state === "suspended") {
				void audioCtx.resume().catch(() => {
					// Best-effort — playback still scheduled below.
				});
			}
			const src = audioCtx.createBufferSource();
			src.buffer = buf;
			src.connect(audioCtx.destination);
			// Schedule strictly in the future so the audio thread always has
			// headroom; never schedule "now or earlier" or a Bluetooth sink
			// can glitch the first frame.
			const startAt = Math.max(nextStartAt, audioCtx.currentTime + 0.02);
			src.start(startAt);
			nextStartAt = startAt + buf.duration;
			liveSources.add(src);
			setSpeaking(true);
			const lead = (startAt - audioCtx.currentTime) * 1000;
			console.log(
				`[voice] play ${buf.duration.toFixed(2)}s scheduled in +${lead.toFixed(0)}ms (ctx.state=${audioCtx.state}, queue depth ${pending.length})`,
			);
			src.onended = () => {
				liveSources.delete(src);
				finish();
			};
		});

	const cancel = () => {
		cancelled = true;
		pending.length = 0;
		for (const src of liveSources) {
			try {
				// Don't null onended — let stop()'s natural onended fire so
				// the in-flight playBuffer promise resolves and drain can
				// unwind. The pendingPlayResolve() below is the fallback for
				// browsers that swallow onended on a stop() before start.
				src.stop();
			} catch {
				// ignore
			}
		}
		liveSources.clear();
		if (pendingPlayResolve) {
			pendingPlayResolve();
			pendingPlayResolve = null;
		}
		// Pull the scheduler clock back to "now" so the next turn doesn't
		// inherit lingering scheduled time from the cancelled one.
		if (ctx) nextStartAt = ctx.currentTime;
		setSpeaking(false);
		// Reset cancelled flag so the queue is reusable for the next turn.
		queueMicrotask(() => {
			cancelled = false;
		});
	};

	onCleanup(() => {
		cancel();
		if (ctx) {
			void ctx.close().catch(() => {
				// ignore
			});
			ctx = null;
		}
	});

	/**
	 * Create + resume the AudioContext synchronously. MUST be called from a
	 * user gesture handler (click/keypress on Send). Browsers freeze any
	 * `resume()` issued outside a recent gesture, so if we lazily wait until
	 * the first audio chunk arrives (often tens of seconds later), the
	 * context stays "suspended" and nothing plays. Call this on every Send
	 * — it's a no-op after the first time.
	 */
	const prime = (): void => {
		const audioCtx = ensureCtx();
		if (!audioCtx) {
			console.warn("[voice] prime: AudioContext not available");
			return;
		}
		console.log(`[voice] prime: ctx.state=${audioCtx.state}`);
		if (audioCtx.state === "suspended") {
			void audioCtx
				.resume()
				.then(() => {
					console.log(`[voice] resume succeeded, ctx.state=${audioCtx.state}`);
				})
				.catch((e) => {
					console.warn("[voice] AudioContext resume failed", e);
				});
		}
	};

	return { enqueueAudioBytes, prime, cancel, isSpeaking };
}

// Voice-mode guidance now lives in MCP's system prompt (conditional on
// the request's `voice_mode` flag), so the frontend no longer needs to
// prepend an instruction blob to each user message. Whisper auto-detects
// the input language and OpenAI TTS infers the output language from the
// model's response text — no language picker required.
