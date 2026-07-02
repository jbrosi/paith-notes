<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Regression tests for PUT /api/nooks/{nookId}/notes/{noteId}:
 *   omitting a field must leave that field UNCHANGED, not clear it.
 *
 * This was the AI-hits-update_note-with-only-{title} bug — the backend
 * was defaulting missing content to '' and wiping the note body.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, nookId, noteId] */
function partialUpdateSetup(string $idPart): array
{
    $userId = "bbbbbbbb-bbbb-4bbb-8bbb-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'partial-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Original Title',
        'content' => "Line 1\nLine 2\nLine 3\n",
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];

    return [$headers, $nookId, $noteId];
}

it('updates only the title when content is omitted, leaving content unchanged', function (): void {
    [$headers, $nookId, $noteId] = partialUpdateSetup('aaaaaaaaaaaa');

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'title' => 'Renamed Title',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['note']['title'])->toBe('Renamed Title');
    expect($body['note']['content'])->toBe("Line 1\nLine 2\nLine 3\n");
});

it('updates only the content when title is omitted, leaving title unchanged', function (): void {
    [$headers, $nookId, $noteId] = partialUpdateSetup('bbbbbbbbbbbb');

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'content' => 'Brand new body',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['note']['title'])->toBe('Original Title');
    expect($body['note']['content'])->toBe('Brand new body');
});

it('accepts an explicit empty content string as a real clear', function (): void {
    [$headers, $nookId, $noteId] = partialUpdateSetup('cccccccccccc');

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'title' => 'Original Title',
        'content' => '',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['note']['content'])->toBe('');
});

it('leaves both title and content unchanged when neither is provided', function (): void {
    [$headers, $nookId, $noteId] = partialUpdateSetup('dddddddddddd');

    // Only touch attributes (empty here, but valid). Title + content stay.
    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'attributes' => new stdClass(),
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['note']['title'])->toBe('Original Title');
    expect($body['note']['content'])->toBe("Line 1\nLine 2\nLine 3\n");
});
