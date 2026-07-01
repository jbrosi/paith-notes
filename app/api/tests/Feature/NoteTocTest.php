<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Feature tests for GET /api/nooks/{nookId}/notes/{noteId}/toc — the
 * cheap heading-only navigation primitive paired with get_note_section.
 *
 * Key contract: each heading reports position_end + chars so the AI
 * can size sections and read just the relevant chunk via get_note_section
 * without having to compute the next-equal-or-higher-level lookup itself.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, nookId, noteId] */
function tocTestSetup(string $idPart, string $content): array
{
    $userId = "abababab-abab-4bab-8bab-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'toc-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];
    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'TOC Subject',
        'content' => $content,
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];
    return [$headers, $nookId, $noteId];
}

it('returns title, content_chars, version, and an empty headings array for a heading-less note', function (): void {
    [$headers, $nookId, $noteId] = tocTestSetup('100000000001', "plain text\nno headings at all\n");

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/toc", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);

    $body = json_decode($res['body'], true);
    expect($body['toc']['note_id'])->toBe($noteId);
    expect($body['toc']['nook_id'])->toBe($nookId);
    expect($body['toc']['title'])->toBe('TOC Subject');
    expect($body['toc']['content_chars'])->toBeGreaterThan(0);
    expect($body['toc']['version'])->toBeGreaterThanOrEqual(0);
    expect($body['toc']['headings'])->toBe([]);
});

it('returns headings ordered by position', function (): void {
    $content = "# First\nintro\n\n## Sub one\nstuff\n\n## Sub two\nmore stuff\n\n# Second\nlater\n";
    [$headers, $nookId, $noteId] = tocTestSetup('100000000002', $content);

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/toc", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);

    $headings = json_decode($res['body'], true)['toc']['headings'];
    expect($headings)->toHaveCount(4);
    expect(array_column($headings, 'text'))->toBe(['First', 'Sub one', 'Sub two', 'Second']);
    expect(array_column($headings, 'level'))->toBe([1, 2, 2, 1]);

    // Positions strictly increasing.
    $positions = array_column($headings, 'position');
    expect($positions[1])->toBeGreaterThan($positions[0]);
    expect($positions[2])->toBeGreaterThan($positions[1]);
    expect($positions[3])->toBeGreaterThan($positions[2]);
});

it('computes position_end as the next equal-or-higher-level heading start (or content end)', function (): void {
    // First h1 owns its body + the two h2 children — its position_end
    // should be where Second h1 starts.
    // First h2 ends at the next h2 (Sub two).
    // Last h1 ends at content_chars.
    $content = "# First\nintro\n\n## Sub one\nstuff\n\n## Sub two\nmore stuff\n\n# Second\nlater\n";
    [$headers, $nookId, $noteId] = tocTestSetup('100000000003', $content);

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/toc", $headers, '');
    $toc = json_decode($res['body'], true)['toc'];
    $headings = $toc['headings'];
    $contentChars = $toc['content_chars'];

    // First h1 (index 0) ends where Second h1 (index 3) starts.
    expect($headings[0]['position_end'])->toBe($headings[3]['position']);
    // First h2 (index 1) ends where Second h2 (index 2) starts.
    expect($headings[1]['position_end'])->toBe($headings[2]['position']);
    // Second h2 (index 2) ends where Second h1 (index 3) starts (next ≤ h2).
    expect($headings[2]['position_end'])->toBe($headings[3]['position']);
    // Last h1 (index 3) ends at end of content.
    expect($headings[3]['position_end'])->toBe($contentChars);

    // chars = position_end - position, every heading.
    foreach ($headings as $h) {
        expect($h['chars'])->toBe($h['position_end'] - $h['position']);
        expect($h['chars'])->toBeGreaterThan(0);
    }
});

it('returns 404 when the note does not exist', function (): void {
    [$headers, $nookId] = tocTestSetup('100000000004', '# x');
    $fakeNoteId = '00000000-0000-4000-8000-000000000000';

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$fakeNoteId}/toc", $headers, '');
    expect($res['status'])->toBe(404);
});

it('returns 403 when the caller is not a member of the nook', function (): void {
    [, $ownerNookId, $ownerNoteId] = tocTestSetup('100000000005', "# x\nbody\n");

    $strangerHeaders = ['X-Nook-User' => 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $strangerHeaders, '');

    $res = App::handle('GET', "/api/nooks/{$ownerNookId}/notes/{$ownerNoteId}/toc", $strangerHeaders, '');
    expect($res['status'])->toBe(403);
});

it('stays in sync after edit_note (HeadingsService re-runs on partial edits too)', function (): void {
    $content = "# Initial\nbody\n";
    [$headers, $nookId, $noteId] = tocTestSetup('100000000006', $content);

    // Read current version to feed edit_note's optimistic lock.
    $read = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, '');
    $version = (int)json_decode($read['body'], true)['note']['version'];

    // Surgical edit: rename the heading.
    $edit = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [['old_string' => '# Initial', 'new_string' => '# Renamed Heading']],
    ]));
    expect($edit['status'])->toBe(200, $edit['body']);

    // TOC should reflect the new heading text.
    $tocRes = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/toc", $headers, '');
    $headings = json_decode($tocRes['body'], true)['toc']['headings'];
    expect($headings)->toHaveCount(1);
    expect($headings[0]['text'])->toBe('Renamed Heading');
});
