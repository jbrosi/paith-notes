/**
 * Streaming parser for `[[voice: instruction]]` sentence-inflection markers
 * emitted by the model in voice mode. Each text delta from Anthropic gets
 * pushed through `push()`; output is:
 *   - `visible`: the same text with markers stripped (forwarded to the chat
 *     transcript / text_delta SSE so the user never sees raw `[[voice:…]]`).
 *   - `segments`: an ordered list of `{text, instr}` pairs to feed into the
 *     per-sentence TTS buffer.
 *
 * Why brackets-with-prefix:
 *   - The app already uses `[[note:<uuid>]]` for cross-note links in the
 *     same markdown. Requiring a `voice:` prefix keeps the two namespaces
 *     disjoint — the parser only consumes brackets that start with
 *     `[[voice:`, leaving `[[note:…]]` and any other bracket use untouched.
 *   - Claude is heavily trained on Anthropic's tool-use
 *     `<parameter name="…">…</parameter>` convention and slips into it
 *     whenever the system prompt asks for XML-shaped wrappers. The bracket
 *     syntax leans on patterns Claude is very reliable at (citations,
 *     markdown link refs) and has no collision with tool-call output.
 *
 * Semantics: a marker sets the instruction for the *next sentence boundary*
 * only. After that sentence completes, the modifier clears — no carryover.
 *
 *   [[voice: warm]] Welcome back.          ← "Welcome back." spoken warm
 *   The day is going well.                 ← spoken plain
 *   [[voice: whisper]] Here's a secret.    ← "Here's a secret." whispered
 *
 * Partial markers at a chunk boundary (e.g. `[`, `[[`, `[[voi`, `[[voice:w`)
 * are held back until enough characters arrive to disambiguate. `flush()`
 * drains the buffer at end-of-stream.
 */
export type VoiceSegment = { text: string; instr: string | null };
export type StripperOutput = { visible: string; segments: VoiceSegment[] };

const OPEN = '[[voice:';
const CLOSE = ']]';

// Sentence-end detection — matches `.!?…` optionally followed by a closing
// quote / bracket, then a space-or-string-end. Same shape as chat.ts uses.
const SENTENCE_END_RE = /[.!?…]+["')\]]*(?=\s|$)/;

export class VoiceTagStripper {
  private pending = '';
  // Instruction to apply to the next emitted text. Cleared as soon as
  // a sentence-end is observed in an emit.
  private activeInstr: string | null = null;

  push(chunk: string): StripperOutput {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): StripperOutput {
    return this.drain(true);
  }

  private drain(final: boolean): StripperOutput {
    const visibleParts: string[] = [];
    const segments: VoiceSegment[] = [];

    while (this.pending.length > 0) {
      // Look for the start of a marker.
      const openIdx = this.pending.indexOf(OPEN);

      if (openIdx < 0) {
        // No marker in sight. Hold back trailing `[` that *might* turn
        // into `[[` once more arrives (unless this is the final flush).
        const hold = final ? 0 : suffixPrefixOverlap(this.pending, OPEN);
        const emitLen = this.pending.length - hold;
        if (emitLen > 0) {
          this.emit(this.pending.slice(0, emitLen), visibleParts, segments);
        }
        this.pending = this.pending.slice(emitLen);
        break;
      }

      if (openIdx > 0) {
        // Emit text before the marker first.
        this.emit(this.pending.slice(0, openIdx), visibleParts, segments);
        this.pending = this.pending.slice(openIdx);
      }

      // We're now at the start of `[[`. Try to find the matching `]]`.
      const closeIdx = this.pending.indexOf(CLOSE, OPEN.length);
      if (closeIdx < 0) {
        if (final) {
          // Stream ended with an unclosed marker — leak it as visible so
          // the user at least sees something is off. Should be exotic.
          this.emit(this.pending, visibleParts, segments);
          this.pending = '';
        }
        // Otherwise wait for more chunks to bring the close.
        break;
      }

      const instr = this.pending.slice(OPEN.length, closeIdx).trim();
      this.pending = this.pending.slice(closeIdx + CLOSE.length);
      // Strip a single leading space after the marker so the spoken text
      // doesn't pick up the model's `[[X]] sentence` formatting space.
      if (this.pending.startsWith(' ')) {
        this.pending = this.pending.slice(1);
      }
      // Set the instruction for the upcoming emit. Drops the active one if
      // we're back-to-back: `[[a]] [[b]] text` → only `[[b]]` survives.
      this.activeInstr = instr || null;
    }

    return { visible: visibleParts.join(''), segments };
  }

  /**
   * Emits a chunk of cleaned text. If the chunk spans a sentence boundary,
   * splits it so the active instruction only applies to the first part
   * (the rest emits with no instruction). This is what enforces the
   * "applies to the prefixed sentence only" semantic.
   */
  private emit(text: string, visibleParts: string[], segments: VoiceSegment[]): void {
    if (text === '') return;
    visibleParts.push(text);

    let remaining = text;
    while (remaining.length > 0) {
      if (this.activeInstr === null) {
        segments.push({ text: remaining, instr: null });
        return;
      }
      const m = SENTENCE_END_RE.exec(remaining);
      if (!m) {
        // No sentence end yet — emit the whole thing with the active instr.
        segments.push({ text: remaining, instr: this.activeInstr });
        return;
      }
      // Split at end-of-sentence; the instructed sentence keeps `instr`,
      // the rest continues with no instruction.
      const cut = m.index + m[0].length;
      segments.push({ text: remaining.slice(0, cut), instr: this.activeInstr });
      this.activeInstr = null;
      remaining = remaining.slice(cut);
    }
  }
}

/**
 * Returns the length of the longest non-empty suffix of `text` that is also a
 * (non-empty) prefix of `target`. Used to hold back chars that *might* be the
 * start of a marker once the next chunk arrives.
 */
function suffixPrefixOverlap(text: string, target: string): number {
  const max = Math.min(text.length, target.length - 1);
  for (let n = max; n > 0; n--) {
    if (target.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Sentence-boundary detector. Reused across runs by appending segments
 * and calling `extract()` whenever new segments arrive. Yields completed
 * sentences (with the instruction active at their first character) and
 * keeps any trailing partial sentence for the next call.
 */
export type Sentence = { text: string; instr: string | null };

export class SentenceBuffer {
  private segments: VoiceSegment[] = [];

  push(seg: VoiceSegment): void {
    if (!seg.text) return;
    this.segments.push(seg);
  }

  pushAll(segs: VoiceSegment[]): void {
    for (const s of segs) this.push(s);
  }

  /** Pop all complete sentences. The trailing partial sentence stays buffered. */
  extract(): Sentence[] {
    const out: Sentence[] = [];
    while (true) {
      const sentence = this.popOne();
      if (!sentence) break;
      out.push(sentence);
    }
    return out;
  }

  /** Drain whatever is left as a final sentence, even without terminal punctuation. */
  flush(): Sentence[] {
    const out = this.extract();
    if (this.segments.length === 0) return out;
    const text = this.segments.map((s) => s.text).join('').trim();
    const instr = this.segments[0]!.instr;
    this.segments = [];
    if (text) out.push({ text, instr });
    return out;
  }

  private popOne(): Sentence | null {
    if (this.segments.length === 0) return null;
    const joined = this.segments.map((s) => s.text).join('');
    const m = SENTENCE_END_RE.exec(joined);
    if (!m) return null;
    const cut = m.index + m[0].length;
    const sentenceText = joined.slice(0, cut).trim();
    const remainder = joined.slice(cut);

    // The sentence inherits the instr of the segment whose text the
    // sentence STARTS in (= the first segment with any non-whitespace).
    let instr: string | null = null;
    for (const s of this.segments) {
      if (s.text.trim() !== '') {
        instr = s.instr;
        break;
      }
    }

    // Rebuild segments with whatever's left. The remainder inherits the
    // CURRENT (last) instruction so subsequent sentences pick up tag
    // changes that happened mid-segment.
    this.segments = remainder
      ? [{ text: remainder, instr: this.segments[this.segments.length - 1]!.instr }]
      : [];

    if (!sentenceText) return null;
    return { text: sentenceText, instr };
  }
}
