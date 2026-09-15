import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoExecutable } from './chat.js';

const NOOK = 'nook-1';
const OTHER = 'nook-2';

describe('isAutoExecutable — nook ai_mode = auto_reads', () => {
  it('approve_all: read tools still require approval', () => {
    for (const t of ['get_note', 'search_notes', 'explore_notes', 'get_note_summary']) {
      assert.equal(isAutoExecutable(t, {}, undefined, 'approve_all', NOOK), false, t);
      // undefined mode behaves like the default (approve_all)
      assert.equal(isAutoExecutable(t, {}, undefined, undefined, NOOK), false, t);
    }
  });

  it('auto_reads: current-nook read tools auto-execute', () => {
    for (const t of [
      'get_note',
      'search_notes',
      'explore_notes',
      'get_note_history',
      'get_note_version',
      'compare_note_versions',
      'get_note_summary',
      'get_note_section',
      'read_note_lines',
    ]) {
      assert.equal(isAutoExecutable(t, {}, undefined, 'auto_reads', NOOK), true, t);
    }
  });

  it('auto_reads: a read explicitly scoped to the current nook auto-executes', () => {
    assert.equal(
      isAutoExecutable('get_note', { nook_id: NOOK, note_id: 'x' }, undefined, 'auto_reads', NOOK),
      true,
    );
  });

  it('auto_reads: a read targeting a DIFFERENT nook still prompts', () => {
    assert.equal(
      isAutoExecutable('get_note', { nook_id: OTHER, note_id: 'x' }, undefined, 'auto_reads', NOOK),
      false,
    );
  });

  it('auto_reads: writes and UI tools still require approval', () => {
    for (const t of [
      'create_note',
      'update_note',
      'delete_note',
      'create_note_link',
      'edit_note',
      'edit_note_agent',
      'open_note',
      'create_note_type',
    ]) {
      assert.equal(isAutoExecutable(t, {}, undefined, 'auto_reads', NOOK), false, t);
    }
  });

  it('auto_reads: the read-only current-nook search_agent auto-executes', () => {
    assert.equal(isAutoExecutable('search_agent', { task: 'x' }, undefined, 'auto_reads', NOOK), true);
    // ...but still needs approval when the nook is not in auto_reads.
    assert.equal(isAutoExecutable('search_agent', { task: 'x' }, undefined, 'approve_all', NOOK), false);
  });

  it('memory + always-auto read primitives stay auto regardless of mode', () => {
    assert.equal(isAutoExecutable('memory_search', {}, undefined, 'approve_all', NOOK), true);
    assert.equal(isAutoExecutable('get_note_toc', {}, undefined, 'approve_all', NOOK), true);
  });

  it('cross-nook search_all_nooks always requires approval, even under auto_reads', () => {
    assert.equal(isAutoExecutable('search_all_nooks', {}, undefined, 'approve_all', NOOK), false);
    assert.equal(isAutoExecutable('search_all_nooks', {}, undefined, 'auto_reads', NOOK), false);
  });

  it('frontend-executed tools never auto-execute, even under auto_reads', () => {
    assert.equal(isAutoExecutable('get_current_editor', {}, undefined, 'auto_reads', NOOK), false);
  });
});
