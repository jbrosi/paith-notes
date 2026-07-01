import { createSignal } from "solid-js";
import wakeWorkletUrl from "./wake-resampler.worklet.js?url";

// Wake-word client. Opens a WebSocket to a local openWakeWord sidecar
// (typically ws://localhost:8889/listen — running on the SAME machine
// as the browser, see app/wake/ + the kiosk warning in
// deploy/host/docker-compose.yml). Streams 16kHz int16 mono PCM frames
// continuously. On the server's {"type":"wake"} event, fires onWake;
// caller is expected to teardown and hand off to the VAD recognizer.

export type WakeEvent = { model: string; score: number };

export type WakeOptions = {
	/** ws:// URL of the wake sidecar's /listen endpoint. */
	url: string;
	/** Fired on a wake detection. Stop the listener from inside the callback. */
	onWake: (event: WakeEvent) => void;
	/** Fired on any connection / mic / protocol error. */
	onError?: (msg: string) => void;
};

export type WakeState = "idle" | "connecting" | "listening" | "error";

export function isWakeSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof AudioWorkletNode !== "undefined" &&
		typeof WebSocket !== "undefined"
	);
}

export function createWakeListener(opts: WakeOptions) {
	const [state, setState] = createSignal<WakeState>("idle");
	let ws: WebSocket | null = null;
	let stream: MediaStream | null = null;
	let audioCtx: AudioContext | null = null;
	let worklet: AudioWorkletNode | null = null;
	let source: MediaStreamAudioSourceNode | null = null;
	// Set when stop() runs so a late-arriving wake / error doesn't
	// re-trigger callbacks after the caller has moved on.
	let cancelled = false;

	const teardown = async () => {
		if (worklet) {
			try {
				worklet.disconnect();
			} catch {
				/* ignore */
			}
			worklet = null;
		}
		if (source) {
			try {
				source.disconnect();
			} catch {
				/* ignore */
			}
			source = null;
		}
		if (stream) {
			for (const t of stream.getTracks()) t.stop();
			stream = null;
		}
		if (audioCtx && audioCtx.state !== "closed") {
			try {
				await audioCtx.close();
			} catch {
				/* ignore */
			}
		}
		audioCtx = null;
		if (ws) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			ws = null;
		}
		setState("idle");
	};

	const fail = (msg: string) => {
		if (cancelled) return;
		setState("error");
		opts.onError?.(msg);
		void teardown();
	};

	const start = async () => {
		if (ws || audioCtx) return;
		cancelled = false;
		setState("connecting");
		try {
			// Open the socket first — if the sidecar isn't running we want
			// to fail BEFORE asking for mic permission (no permission
			// prompt for a feature that can't work).
			const socket = new WebSocket(opts.url);
			socket.binaryType = "arraybuffer";
			ws = socket;
			await new Promise<void>((resolve, reject) => {
				const onOpen = () => {
					socket.removeEventListener("error", onErr);
					resolve();
				};
				const onErr = () => {
					socket.removeEventListener("open", onOpen);
					reject(new Error("wake socket failed to open"));
				};
				socket.addEventListener("open", onOpen, { once: true });
				socket.addEventListener("error", onErr, { once: true });
			});

			socket.addEventListener("message", (e) => {
				if (typeof e.data !== "string") return;
				try {
					const msg = JSON.parse(e.data) as {
						type: string;
						model?: string;
						score?: number;
						message?: string;
					};
					if (msg.type === "ready") {
						if (!cancelled) setState("listening");
					} else if (msg.type === "wake" && msg.model) {
						if (!cancelled)
							opts.onWake({
								model: msg.model,
								score: msg.score ?? 1,
							});
					} else if (msg.type === "error") {
						fail(msg.message ?? "wake server error");
					}
				} catch {
					/* malformed JSON — ignore */
				}
			});

			socket.addEventListener("close", () => {
				if (!cancelled && state() === "listening") {
					fail("wake socket closed unexpectedly");
				}
			});

			// Now ask for the mic.
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					// Echo cancellation matters once TTS playback runs through
					// the same speakers — without it, the assistant's own
					// voice can trigger the wake word.
					echoCancellation: true,
					noiseSuppression: true,
				},
			});

			audioCtx = new AudioContext();
			await audioCtx.audioWorklet.addModule(wakeWorkletUrl);
			source = audioCtx.createMediaStreamSource(stream);
			worklet = new AudioWorkletNode(audioCtx, "wake-resampler");
			worklet.port.onmessage = (e) => {
				// e.data is a transferred ArrayBuffer of int16 PCM at 16kHz.
				if (ws && ws.readyState === WebSocket.OPEN && !cancelled) {
					ws.send(e.data as ArrayBuffer);
				}
			};
			// Connect source → worklet only. Do NOT connect worklet to
			// destination — we don't want mic playback.
			source.connect(worklet);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			fail(`Wake listener failed to start: ${msg}`);
		}
	};

	const stop = () => {
		cancelled = true;
		void teardown();
	};

	return { state, start, stop };
}
