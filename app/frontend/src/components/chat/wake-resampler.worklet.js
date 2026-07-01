// AudioWorklet for the wake-word listener. Runs inside the audio thread
// so frame conversion doesn't block the UI. Pulls Float32 mic samples
// from the realtime audio graph, resamples from the context's native
// rate (usually 48kHz) down to 16kHz, packs into 80ms int16 frames
// (1280 samples — what openWakeWord wants), and posts each frame to
// the main thread as an ArrayBuffer for WebSocket dispatch.
//
// Linear interpolation is good enough here: openWakeWord runs the
// audio through a mel-spectrogram + small neural net that smooths over
// minor resampling artifacts. Real sinc resampling would be overkill.

class WakeResampler extends AudioWorkletProcessor {
	constructor() {
		super();
		this.outRate = 16000;
		this.ratio = sampleRate / this.outRate; // `sampleRate` is a global in AudioWorklet
		this.buffer = []; // ring of pending input Float32 samples
		this.outPos = 0; // fractional read position into `buffer`
		this.FRAME_SAMPLES = 1280; // 80ms at 16kHz
		this.frame = new Int16Array(this.FRAME_SAMPLES);
		this.frameIdx = 0;
	}

	process(inputs) {
		const inBuf = inputs[0]?.[0]; // first input, first channel; Float32Array
		if (!inBuf) return true;
		for (let i = 0; i < inBuf.length; i++) this.buffer.push(inBuf[i]);

		while (this.outPos + this.ratio < this.buffer.length) {
			const i0 = Math.floor(this.outPos);
			const i1 = i0 + 1;
			const t = this.outPos - i0;
			const f0 = this.buffer[i0];
			const f1 = this.buffer[i1] ?? f0;
			const sample = f0 * (1 - t) + f1 * t;
			const clamped = Math.max(-1, Math.min(1, sample));
			this.frame[this.frameIdx++] = Math.round(clamped * 32767);
			this.outPos += this.ratio;

			if (this.frameIdx >= this.FRAME_SAMPLES) {
				// Copy and transfer the underlying buffer so the main thread
				// owns it; we keep a fresh Int16Array for the next frame.
				const out = this.frame.buffer.slice(0);
				this.port.postMessage(out, [out]);
				this.frameIdx = 0;
			}
		}

		// Trim consumed prefix off the input buffer so it doesn't grow
		// unbounded. Keep a small tail so the next linear interpolation
		// has a previous sample to lerp from.
		if (this.outPos > 4096) {
			const consumed = Math.floor(this.outPos);
			this.buffer.splice(0, consumed);
			this.outPos -= consumed;
		}
		return true;
	}
}

registerProcessor("wake-resampler", WakeResampler);
