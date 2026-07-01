import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import styles from "./VoiceEnrollment.module.css";

// Voice-profile enrollment modal. Captures a 6-20s clip of the user
// speaking naturally and POSTs it to /api/voice/enroll. The voice
// container ships the same audio through wespeaker to produce a
// 192-dim voiceprint and stores it in its enrollment JSON.
//
// Privacy: the modal is the only UI path for enrollment. With zero
// enrolled speakers, /api/voice/identify always returns null and no
// per-message [spoken by …] tags appear in the chat — the system is
// effectively off until someone deliberately opts in here.

type Enrollment = {
	name: string;
	enrolled_at: string;
	samples: number;
};

type ApiList = { enrollments: Enrollment[] };

const ENROLLMENTS_URL = "/api/voice/enrollments";
const ENROLL_URL = "/api/voice/enroll";
// Recommended take length. The voice container hard-fails below 4s;
// 10s is the sweet spot for a stable voiceprint without making the
// user feel like they're auditioning. Cap at 20s so people don't
// accidentally leave it running.
const RECORD_MIN_S = 6;
const RECORD_RECOMMENDED_S = 10;
const RECORD_MAX_S = 20;

async function fetchEnrollments(): Promise<Enrollment[]> {
	const res = await fetch(ENROLLMENTS_URL, { credentials: "include" });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as ApiList;
	return data.enrollments ?? [];
}

async function deleteEnrollment(name: string): Promise<void> {
	const res = await fetch(`${ENROLL_URL}/${encodeURIComponent(name)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function pickMime(): string {
	if (typeof MediaRecorder === "undefined") return "";
	for (const c of [
		"audio/webm;codecs=opus",
		"audio/webm",
		"audio/mp4",
		"audio/ogg;codecs=opus",
	]) {
		if (MediaRecorder.isTypeSupported(c)) return c;
	}
	return "";
}

export function VoiceEnrollment(props: { onClose: () => void }) {
	const [enrollments, { refetch }] = createResource(fetchEnrollments);
	const [name, setName] = createSignal("");
	const [recording, setRecording] = createSignal(false);
	const [elapsed, setElapsed] = createSignal(0);
	const [submitting, setSubmitting] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [recordedBlob, setRecordedBlob] = createSignal<Blob | null>(null);
	const [replaceExisting, setReplaceExisting] = createSignal(false);

	let recorder: MediaRecorder | null = null;
	let stream: MediaStream | null = null;
	let chunks: Blob[] = [];
	let timer: ReturnType<typeof setInterval> | null = null;
	let startedAt = 0;
	let stopTimer: ReturnType<typeof setTimeout> | null = null;

	const cleanupRecording = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (stopTimer) {
			clearTimeout(stopTimer);
			stopTimer = null;
		}
		if (stream) {
			for (const t of stream.getTracks()) t.stop();
			stream = null;
		}
		recorder = null;
	};

	const startRecording = async () => {
		setError(null);
		setRecordedBlob(null);
		chunks = [];
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setError(
				msg.includes("denied") || msg.includes("Permission")
					? "Microphone permission denied."
					: `Could not start microphone: ${msg}`,
			);
			return;
		}

		const mime = pickMime();
		try {
			recorder = mime
				? new MediaRecorder(stream, { mimeType: mime })
				: new MediaRecorder(stream);
		} catch (err) {
			cleanupRecording();
			setError(err instanceof Error ? err.message : "MediaRecorder failed.");
			return;
		}

		recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) chunks.push(e.data);
		};
		recorder.onstop = () => {
			const blob = new Blob(chunks, {
				type: recorder?.mimeType || "audio/webm",
			});
			chunks = [];
			cleanupRecording();
			setRecording(false);
			setRecordedBlob(blob);
		};

		startedAt = Date.now();
		setElapsed(0);
		timer = setInterval(() => {
			setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		}, 250);
		// Hard cap at RECORD_MAX_S so leaving the tab doesn't burn battery.
		stopTimer = setTimeout(() => {
			if (recorder && recorder.state !== "inactive") recorder.stop();
		}, RECORD_MAX_S * 1000);

		try {
			recorder.start();
			setRecording(true);
		} catch (err) {
			cleanupRecording();
			setError(
				err instanceof Error ? err.message : "Could not start recording.",
			);
		}
	};

	const stopRecording = () => {
		if (recorder && recorder.state !== "inactive") {
			try {
				recorder.stop();
			} catch {
				cleanupRecording();
				setRecording(false);
			}
		}
	};

	const submitEnrollment = async () => {
		const cleanName = name().trim();
		const blob = recordedBlob();
		if (!cleanName || !blob) {
			setError("Pick a name and record a clip first.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const form = new FormData();
			form.append("audio", blob, "enrollment.webm");
			form.append("name", cleanName);
			if (replaceExisting()) form.append("replace", "true");
			const res = await fetch(ENROLL_URL, {
				method: "POST",
				credentials: "include",
				body: form,
			});
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new Error(`Enrollment failed: ${detail || res.statusText}`);
			}
			setRecordedBlob(null);
			setName("");
			setReplaceExisting(false);
			refetch();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Enrollment failed.");
		} finally {
			setSubmitting(false);
		}
	};

	const onDelete = async (n: string) => {
		if (!window.confirm(`Remove voice profile for "${n}"?`)) return;
		try {
			await deleteEnrollment(n);
			refetch();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Delete failed.");
		}
	};

	onCleanup(cleanupRecording);

	const formatDate = (iso: string) => {
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
				year: "numeric",
			});
		} catch {
			return iso;
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is convention-only, every action also has a button
		// biome-ignore lint/a11y/useKeyWithClickEvents: ESC handling lives on the close button + form fields, this is just a click-outside shortcut
		<div
			class={styles.backdrop}
			onClick={(e) => e.target === e.currentTarget && props.onClose()}
		>
			<div class={styles.modal}>
				<div class={styles.header}>
					<h2 class={styles.title}>Voice profiles</h2>
					<button
						type="button"
						class={styles.closeBtn}
						onClick={props.onClose}
						aria-label="Close"
					>
						×
					</button>
				</div>

				<p class={styles.intro}>
					Enroll your voice so the assistant can address you by name.
					Voiceprints stay on your homelab; nothing's uploaded externally.
					Anyone enrolled here can be identified in chat. Don't enroll guests
					without their consent.
				</p>

				<div class={styles.recordPanel}>
					<div class={styles.fieldRow}>
						<label class={styles.label} for="enroll-name">
							Name
						</label>
						<input
							id="enroll-name"
							class={styles.input}
							type="text"
							value={name()}
							maxLength={80}
							placeholder="e.g. Johannes"
							onInput={(e) => setName(e.currentTarget.value)}
							disabled={recording() || submitting()}
						/>
					</div>

					<div class={styles.recordRow}>
						<Show
							when={!recording()}
							fallback={
								<>
									<button
										type="button"
										class={`${styles.recordBtn} ${styles.recording}`}
										onClick={stopRecording}
									>
										■ Stop ({elapsed()}s)
									</button>
									<span class={styles.hint}>
										Speak naturally — keep going until at least {RECORD_MIN_S}s.
									</span>
								</>
							}
						>
							<button
								type="button"
								class={styles.recordBtn}
								onClick={startRecording}
								disabled={submitting()}
							>
								🎤 Record ({RECORD_RECOMMENDED_S}s recommended)
							</button>
							<Show when={recordedBlob()}>
								<span class={styles.ready}>
									✓ {((recordedBlob()?.size ?? 0) / 1024).toFixed(0)} KB
									captured — ready to enroll
								</span>
							</Show>
						</Show>
					</div>

					<Show when={enrollments()?.some((e) => e.name === name().trim())}>
						<label class={styles.checkboxRow}>
							<input
								type="checkbox"
								checked={replaceExisting()}
								onChange={(e) => setReplaceExisting(e.currentTarget.checked)}
							/>
							<span>
								Replace existing voiceprint (default: refine the current one by
								blending in this new sample)
							</span>
						</label>
					</Show>

					<div class={styles.submitRow}>
						<button
							type="button"
							class={styles.submitBtn}
							onClick={submitEnrollment}
							disabled={!recordedBlob() || !name().trim() || submitting()}
						>
							{submitting() ? "Enrolling…" : "Enroll"}
						</button>
					</div>

					<Show when={error()}>
						<div class={styles.error}>{error()}</div>
					</Show>
				</div>

				<div class={styles.listPanel}>
					<h3 class={styles.subtitle}>Enrolled voices</h3>
					<Show when={!enrollments.loading} fallback={<p>Loading…</p>}>
						<Show
							when={(enrollments() ?? []).length > 0}
							fallback={
								<p class={styles.empty}>
									No one is enrolled yet. Identification is off until at least
									one voiceprint exists.
								</p>
							}
						>
							<ul class={styles.list}>
								<For each={enrollments()}>
									{(e) => (
										<li class={styles.listItem}>
											<div>
												<div class={styles.name}>{e.name}</div>
												<div class={styles.meta}>
													{e.samples} sample{e.samples === 1 ? "" : "s"} ·
													enrolled {formatDate(e.enrolled_at)}
												</div>
											</div>
											<button
												type="button"
												class={styles.deleteBtn}
												onClick={() => onDelete(e.name)}
												aria-label={`Remove ${e.name}`}
											>
												Delete
											</button>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>
				</div>
			</div>
		</div>
	);
}
