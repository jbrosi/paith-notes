<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Feature tests for the per-user note-draft endpoints:
 *   GET    /api/nooks/{nookId}/notes/{noteId}/draft
 *   PUT    /api/nooks/{nookId}/notes/{noteId}/draft
 *   DELETE /api/nooks/{nookId}/notes/{noteId}/draft
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, nookId, noteId] */
function draftTestSetup(string $idPart, string $initialContent = "hello\n"): array
{
    $userId = "aaaaaaaa-aaaa-4aaa-8aaa-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'draft-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Test',
        'content' => $initialContent,
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];

    return [$headers, $nookId, $noteId];
}

it('returns draft=null when no draft exists', function (): void {
    [$headers, $nookId, $noteId] = draftTestSetup('aaaaaaaaaaaa');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['draft'])->toBeNull();
    expect($body['note_updated_at'])->toBeString();
});

it('upserts a draft and bumps version on each write', function (): void {
    [$headers, $nookId, $noteId] = draftTestSetup('bbbbbbbbbbbb');

    $res1 = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, json_encode([
        'title' => 'Test',
        'content' => "hello\nfirst draft\n",
    ]));
    expect($res1['status'])->toBe(200, $res1['body']);
    $b1 = json_decode($res1['body'], true);
    expect($b1['version'])->toBe(1);

    $res2 = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, json_encode([
        'title' => 'Test',
        'content' => "hello\nsecond draft\n",
    ]));
    expect($res2['status'])->toBe(200, $res2['body']);
    expect(json_decode($res2['body'], true)['version'])->toBe(2);
});

it('returns the persisted draft on subsequent GET', function (): void {
    [$headers, $nookId, $noteId] = draftTestSetup('cccccccccccc');

    App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, json_encode([
        'title' => 'Different Title',
        'content' => "brand new content\n",
    ]));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, '');
    $body = json_decode($res['body'], true);
    expect($body['draft'])->not->toBeNull();
    expect($body['draft']['title'])->toBe('Different Title');
    expect($body['draft']['content'])->toBe("brand new content\n");
    expect($body['draft']['version'])->toBe(1);
});

it('deletes the draft on DELETE', function (): void {
    [$headers, $nookId, $noteId] = draftTestSetup('dddddddddddd');

    App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, json_encode([
        'title' => 'x',
        'content' => 'y',
    ]));

    $del = App::handle('DELETE', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, '');
    expect($del['status'])->toBe(200, $del['body']);

    $get = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headers, '');
    expect(json_decode($get['body'], true)['draft'])->toBeNull();
});

it('drafts are isolated per user (user B cannot see user A drafts)', function (): void {
    // User A creates a nook + note + draft
    $userA = 'aaaaaaaa-eeee-4aaa-8aaa-eeeeeeeeeeee';
    $userB = 'bbbbbbbb-eeee-4bbb-8bbb-eeeeeeeeeeee';
    $headersA = ['X-Nook-User' => $userA, 'X-Nook-Groups' => 'paith/notes'];
    $headersB = ['X-Nook-User' => $userB, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headersA, '');
    App::handle('GET', '/api/me', $headersB, '');

    $nook = App::handle('POST', '/api/nooks', $headersA, json_encode(['name' => 'shared']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];

    // A invites B as read-write via direct membership insert (short-cut
    // vs. going through the invitation flow — this test isn't about that).
    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:n, :u, 'readwrite')")
        ->execute([':n' => $nookId, ':u' => $userB]);

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headersA, json_encode([
        'title' => 'shared', 'content' => 'x',
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];

    App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headersA, json_encode([
        'title' => 'A wrote this', 'content' => 'A content',
    ]));

    // B does NOT see A's draft; B sees their own null draft.
    $bGet = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headersB, '');
    expect(json_decode($bGet['body'], true)['draft'])->toBeNull();

    // A still sees their own draft.
    $aGet = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $headersA, '');
    expect(json_decode($aGet['body'], true)['draft']['content'])->toBe('A content');
});

it('rejects PUT for read-only members', function (): void {
    $owner = 'aaaaaaaa-ffff-4aaa-8aaa-111111111111';
    $ro = 'bbbbbbbb-ffff-4bbb-8bbb-111111111111';
    $ownerH = ['X-Nook-User' => $owner, 'X-Nook-Groups' => 'paith/notes'];
    $roH = ['X-Nook-User' => $ro, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $ownerH, '');
    App::handle('GET', '/api/me', $roH, '');

    $nook = App::handle('POST', '/api/nooks', $ownerH, json_encode(['name' => 'ro']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];

    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:n, :u, 'readonly')")
        ->execute([':n' => $nookId, ':u' => $ro]);

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $ownerH, json_encode([
        'title' => 't', 'content' => 'c',
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}/draft", $roH, json_encode([
        'title' => 'nope', 'content' => 'nope',
    ]));
    expect($res['status'])->toBe(403);
});
