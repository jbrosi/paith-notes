<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Feature tests for POST /api/nooks/{nookId}/notes/{noteId}/edit
 * — surgical string-substitution edits with optimistic version locking
 * and atomic multi-edit batching.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string, 2: string, 3: int} [headers, nookId, noteId, version] */
function editTestSetup(string $idPart, string $initialContent = "alpha\nbeta\ngamma\n"): array
{
    $userId = "fcfcfcfc-fcfc-4fcf-8fcf-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'edit-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Test',
        'content' => $initialContent,
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];
    // Read back to get the current version.
    $read = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, '');
    $version = (int)json_decode($read['body'], true)['note']['version'];

    return [$headers, $nookId, $noteId, $version];
}

it('replaces a unique substring and bumps the version', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('aaaaaaaaaaaa');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [
            ['old_string' => 'beta', 'new_string' => 'BETA'],
        ],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['note']['content'])->toBe("alpha\nBETA\ngamma\n");
    expect($body['replacements'])->toBe(1);
    expect($body['note']['version'])->toBeGreaterThan($version);
});

it('rejects when old_string matches more than once and replace_all is false', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('bbbbbbbbbbbb', "x\nx\ny\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [['old_string' => 'x', 'new_string' => 'X']],
    ]));
    expect($res['status'])->toBe(409);
    expect(json_decode($res['body'], true)['error'])->toContain('matched 2 times');
});

it('replace_all=true substitutes every occurrence', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('cccccccccccc', "x\nx\nx\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [['old_string' => 'x', 'new_string' => 'X', 'replace_all' => true]],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['note']['content'])->toBe("X\nX\nX\n");
    expect(json_decode($res['body'], true)['replacements'])->toBe(3);
});

it('rejects when old_string is not found', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('dddddddddddd');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [['old_string' => 'nowhere', 'new_string' => 'x']],
    ]));
    expect($res['status'])->toBe(404);
    expect(json_decode($res['body'], true)['error'])->toContain('not found');
});

it('returns 409 when expected_version is stale', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('eeeeeeeeeeee');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version + 999,
        'edits' => [['old_string' => 'beta', 'new_string' => 'BETA']],
    ]));
    expect($res['status'])->toBe(409);
    $body = json_decode($res['body'], true);
    expect($body['error'])->toContain('edited in the meantime');
    expect($body['current_version'])->toBe($version);
});

it('applies multiple edits atomically in order', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('ffffffffffff', "one\ntwo\nthree\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [
            ['old_string' => 'one', 'new_string' => 'ONE'],
            ['old_string' => 'two', 'new_string' => 'TWO'],
            ['old_string' => 'three', 'new_string' => 'THREE'],
        ],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['note']['content'])->toBe("ONE\nTWO\nTHREE\n");
    expect(json_decode($res['body'], true)['replacements'])->toBe(3);
});

it('an edit can match text produced by an earlier edit in the same batch', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('111111111111', "foo\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [
            ['old_string' => 'foo', 'new_string' => 'bar'],
            ['old_string' => 'bar', 'new_string' => 'baz'],
        ],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['note']['content'])->toBe("baz\n");
});

it('rolls back the entire batch when one edit fails — note content unchanged', function (): void {
    $pdo = test_pdo();
    [$headers, $nookId, $noteId, $version] = editTestSetup('222222222222', "alpha\nbeta\ngamma\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [
            ['old_string' => 'alpha', 'new_string' => 'ALPHA'],
            ['old_string' => 'NOPE',  'new_string' => 'whatever'], // not found → fails
            ['old_string' => 'gamma', 'new_string' => 'GAMMA'],
        ],
    ]));
    expect($res['status'])->toBe(404);

    // Note content must be unchanged, version unchanged.
    $row = $pdo->query("select content, version from global.notes where id = " . $pdo->quote($noteId))
        ->fetch(PDO::FETCH_ASSOC);
    expect($row['content'])->toBe("alpha\nbeta\ngamma\n");
    expect((int)$row['version'])->toBe($version);
});

it('empty new_string deletes the matched text', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('333333333333', "keep this\ndelete this line\nalso keep\n");

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [['old_string' => "delete this line\n", 'new_string' => '']],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['note']['content'])->toBe("keep this\nalso keep\n");
});

it('rejects an empty edits array', function (): void {
    [$headers, $nookId, $noteId, $version] = editTestSetup('444444444444');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'expected_version' => $version,
        'edits' => [],
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('non-empty array');
});

it('requires expected_version', function (): void {
    [$headers, $nookId, $noteId] = editTestSetup('555555555555');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/edit", $headers, json_encode([
        'edits' => [['old_string' => 'beta', 'new_string' => 'BETA']],
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('expected_version');
});

it('returns 404 when the note does not exist', function (): void {
    [$headers, $nookId] = editTestSetup('666666666666');
    $fakeNoteId = '00000000-0000-4000-8000-000000000000';

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$fakeNoteId}/edit", $headers, json_encode([
        'expected_version' => 0,
        'edits' => [['old_string' => 'x', 'new_string' => 'y']],
    ]));
    expect($res['status'])->toBe(404);
});
