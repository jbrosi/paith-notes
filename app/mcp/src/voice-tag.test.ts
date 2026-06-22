import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTagStripper, SentenceBuffer } from './voice-tag.js';

describe('VoiceTagStripper', () => {
  it('passes text through untouched when no markers are present', () => {
    const s = new VoiceTagStripper();
    const r = s.push('Just a normal sentence.');
    assert.equal(r.visible, 'Just a normal sentence.');
    assert.deepEqual(r.segments, [{ text: 'Just a normal sentence.', instr: null }]);
  });

  it('strips a complete marker and applies its instr to the following sentence', () => {
    const s = new VoiceTagStripper();
    const r = s.push('[[voice: warm]] Welcome back. Glad you are here.');
    assert.equal(r.visible, 'Welcome back. Glad you are here.');
    // First sentence picks up the instr; second is back to no instr.
    assert.deepEqual(r.segments, [
      { text: 'Welcome back.', instr: 'warm' },
      { text: ' Glad you are here.', instr: null },
    ]);
  });

  it('marker only applies to its immediate sentence (no carryover)', () => {
    const s = new VoiceTagStripper();
    const r = s.push('[[voice: whisper]] A secret. Then loud. Then plain.');
    assert.equal(r.visible, 'A secret. Then loud. Then plain.');
    // Stripper splits at the FIRST sentence end (to drop the instr); the
    // remainder is one no-instr segment that SentenceBuffer will further
    // split into individual sentences downstream, all carrying instr=null.
    assert.deepEqual(r.segments, [
      { text: 'A secret.', instr: 'whisper' },
      { text: ' Then loud. Then plain.', instr: null },
    ]);
  });

  it('back-to-back markers — the latter wins for the next sentence', () => {
    const s = new VoiceTagStripper();
    const r = s.push('[[voice: a]] [[voice: b]] Hello.');
    assert.deepEqual(r.segments, [{ text: 'Hello.', instr: 'b' }]);
  });

  it('does NOT consume [[note:…]] or other unrelated brackets', () => {
    const s = new VoiceTagStripper();
    const r = s.push('See [[note:abc-123]] and [[other]] for context.');
    assert.equal(r.visible, 'See [[note:abc-123]] and [[other]] for context.');
    assert.deepEqual(r.segments, [
      { text: 'See [[note:abc-123]] and [[other]] for context.', instr: null },
    ]);
  });

  it('buffers a marker split across chunks (open side)', () => {
    const s = new VoiceTagStripper();
    let r = s.push('Hello. [[');
    assert.equal(r.visible, 'Hello. ');
    r = s.push('voice: cal');
    assert.equal(r.visible, '');
    r = s.push('m]] Goodbye.');
    assert.equal(r.visible, 'Goodbye.');
    assert.deepEqual(r.segments[r.segments.length - 1], {
      text: 'Goodbye.',
      instr: 'calm',
    });
  });

  it('buffers a marker split across chunks (close side)', () => {
    const s = new VoiceTagStripper();
    let r = s.push('[[voice: hush');
    assert.equal(r.visible, '');
    r = s.push(']] A secret');
    assert.equal(r.visible, 'A secret');
    assert.deepEqual(r.segments, [{ text: 'A secret', instr: 'hush' }]);
    r = s.push(' is safe.');
    assert.equal(r.visible, ' is safe.');
  });

  it('does not falsely consume [[ that does not become [[voice:', () => {
    const s = new VoiceTagStripper();
    let r = s.push('Hello [[');       // could be marker or note-link or other
    assert.equal(r.visible, 'Hello '); // hold the `[[` as it might continue
    r = s.push('note:abc]] there.');
    assert.equal(r.visible, '[[note:abc]] there.');
  });

  it('flush() emits an unclosed marker as visible (no data loss)', () => {
    const s = new VoiceTagStripper();
    s.push('Hello [[voice: ');
    const tail = s.flush();
    assert.equal(tail.visible, '[[voice: ');
  });

  it('handles multiple complete markers in one buffer', () => {
    const s = new VoiceTagStripper();
    const r = s.push('[[voice: a]] One. Two. [[voice: b]] Three.');
    assert.equal(r.visible, 'One. Two. Three.');
    // The trailing space before `[[voice: b]]` stays as part of the
    // previous chunk; the marker itself strips one leading space after
    // its `]]` so "Three." doesn't get a doubled gap.
    assert.deepEqual(r.segments, [
      { text: 'One.', instr: 'a' },
      { text: ' Two. ', instr: null },
      { text: 'Three.', instr: 'b' },
    ]);
  });

  it('trims whitespace around the instruction value', () => {
    const s = new VoiceTagStripper();
    const r = s.push('[[voice:   warm,  smiling  ]] Hi.');
    assert.deepEqual(r.segments, [{ text: 'Hi.', instr: 'warm,  smiling' }]);
  });
});

describe('SentenceBuffer', () => {
  it('extracts complete sentences and keeps the trailing partial', () => {
    const b = new SentenceBuffer();
    b.push({ text: 'Hello world. Another sentence', instr: null });
    const out = b.extract();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text, 'Hello world.');
    assert.equal(out[0]!.instr, null);
    b.push({ text: ' here.', instr: null });
    const out2 = b.extract();
    assert.equal(out2.length, 1);
    assert.equal(out2[0]!.text, 'Another sentence here.');
  });

  it('inherits the active instruction at sentence start', () => {
    const b = new SentenceBuffer();
    b.push({ text: 'Plain start. ', instr: null });
    b.push({ text: 'Whispered now.', instr: 'whisper' });
    const out = b.extract();
    assert.equal(out.length, 2);
    assert.equal(out[0]!.text, 'Plain start.');
    assert.equal(out[0]!.instr, null);
    assert.equal(out[1]!.text, 'Whispered now.');
    assert.equal(out[1]!.instr, 'whisper');
  });

  it('flush() emits the trailing partial sentence even without punctuation', () => {
    const b = new SentenceBuffer();
    b.push({ text: 'No terminal punctuation here', instr: 'warm' });
    const out = b.flush();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text, 'No terminal punctuation here');
    assert.equal(out[0]!.instr, 'warm');
  });

  it('handles sentence boundary inside a single segment', () => {
    const b = new SentenceBuffer();
    b.push({ text: 'First. Second. Third.', instr: 'mood' });
    const out = b.extract();
    assert.equal(out.length, 3);
    for (const s of out) assert.equal(s.instr, 'mood');
  });
});
