import { createSignal, onCleanup } from "solid-js";

// Backend voice service for the mic upload. TTS no longer goes through a
// per-sentence fetch from the frontend — MCP synthesizes server-side and
// streams audio chunks on the chat SSE.
const STT_ENDPOINT = "/api/voice/stt";

export function isSttSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.MediaRecorder !== "undefined" &&
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia
	);
}

export function isTtsSupported(): boolean {
	// TTS goes through the backend and plays via <audio>, which is universal.
	return typeof window !== "undefined" && typeof Audio !== "undefined";
}

function pickRecorderMime(): string {
	if (typeof MediaRecorder === "undefined") return "";
	const candidates = [
		"audio/webm;codecs=opus",
		"audio/webm",
		"audio/mp4",
		"audio/ogg;codecs=opus",
	];
	for (const c of candidates) {
		if (MediaRecorder.isTypeSupported(c)) return c;
	}
	return "";
}

type RecognizerOptions = {
	onFinal: (text: string) => void;
	onError?: (msg: string) => void;
};

/**
 * Tap-to-record recognizer backed by MediaRecorder + the /stt endpoint.
 * No interim results — Whisper batch-transcribes after the recording stops.
 * The `interim` signal is reused as a status line ("Transcribing…") so the
 * existing ChatInput UI doesn't need to change.
 */
export function createRecognizer(opts: RecognizerOptions) {
	const [isListening, setListening] = createSignal(false);
	const [interim, setInterim] = createSignal("");
	let recorder: MediaRecorder | null = null;
	let stream: MediaStream | null = null;
	let chunks: Blob[] = [];
	let stopRequested = false;

	const releaseStream = () => {
		if (stream) {
			for (const t of stream.getTracks()) t.stop();
			stream = null;
		}
	};

	const teardown = () => {
		if (recorder && recorder.state !== "inactive") {
			try {
				recorder.stop();
			} catch {
				// ignore
			}
		}
		releaseStream();
		recorder = null;
		chunks = [];
		stopRequested = false;
		setListening(false);
		setInterim("");
	};

	const start = async () => {
		if (recorder) return;
		stopRequested = false;
		chunks = [];
		setInterim("");
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			opts.onError?.(
				msg.includes("denied") || msg.includes("Permission")
					? "Microphone permission denied."
					: `Could not access microphone: ${msg}`,
			);
			return;
		}

		const mime = pickRecorderMime();
		try {
			recorder = mime
				? new MediaRecorder(stream, { mimeType: mime })
				: new MediaRecorder(stream);
		} catch (err) {
			releaseStream();
			opts.onError?.(
				err instanceof Error ? err.message : "MediaRecorder failed to start.",
			);
			return;
		}

		recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) chunks.push(e.data);
		};

		recorder.onerror = (e) => {
			const evt = e as unknown as { error?: { message?: string } };
			opts.onError?.(evt.error?.message ?? "Recording error.");
			teardown();
		};

		recorder.onstop = async () => {
			releaseStream();
			setListening(false);
			if (!stopRequested || chunks.length === 0) {
				setInterim("");
				recorder = null;
				return;
			}
			const blob = new Blob(chunks, {
				type: recorder?.mimeType || "audio/webm",
			});
			chunks = [];
			recorder = null;
			setInterim("Transcribing…");
			try {
				const text = await postForTranscript(blob);
				setInterim("");
				if (text) opts.onFinal(text);
			} catch (err) {
				setInterim("");
				opts.onError?.(
					err instanceof Error ? err.message : "Transcription failed.",
				);
			}
		};

		try {
			recorder.start();
			setListening(true);
		} catch (err) {
			teardown();
			opts.onError?.(
				err instanceof Error ? err.message : "Failed to start recording.",
			);
		}
	};

	const stop = () => {
		if (!recorder) return;
		stopRequested = true;
		if (recorder.state !== "inactive") {
			try {
				recorder.stop();
			} catch {
				teardown();
			}
		}
	};

	onCleanup(teardown);

	return { start, stop, isListening, interim };
}

async function postForTranscript(blob: Blob): Promise<string> {
	const form = new FormData();
	form.append("audio", blob, "recording.webm");
	// No language hint — let Whisper autodetect. Forcing the wrong language
	// produces garbled English-shaped output from German speech and vice
	// versa; autodetect picks the dominant language per clip.
	const res = await fetch(STT_ENDPOINT, {
		method: "POST",
		credentials: "include",
		body: form,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`STT ${res.status}: ${detail || res.statusText}`);
	}
	const data = (await res.json()) as { text?: string };
	return (data.text ?? "").trim();
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

// Map dropdown values (incl. engine-pinning pseudo-langs like "en-cb") to
// the language NAME shown to the LLM. The model picks its reply language
// from this string, so it must be unambiguous English.
const VOICE_LANG_NAMES: Record<string, string> = {
	en: "English",
	"en-us": "English",
	"en-gb": "English",
	"en-cb": "English",
	"en-f5": "English",
	de: "German",
	"de-f5": "German",
};

export function voiceModeInstruction(lang: string | undefined): string {
	const langName = VOICE_LANG_NAMES[lang ?? ""] ?? "English";
	return (
		`[Voice mode is active. ALWAYS reply in ${langName}, regardless of the ` +
		`language the user wrote in — the user has selected ${langName} as the ` +
		`spoken output language. Respond conversationally in 1-3 short sentences. ` +
		`No markdown, no code blocks, no bullet lists — your reply will be read aloud. ` +
		`If you need to show structured content, do the work via tools and give a brief spoken summary. ` +
		`When announcing a tool call, say one short conversational sentence about what you're doing ` +
		`(e.g. 'Let me look that up' or 'Saving that to memory now') — never read out tool names, ` +
		`UUIDs, IDs, JSON, or parameter values; the UI shows those visually.]`
	);
}
