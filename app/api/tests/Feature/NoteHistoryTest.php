<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

it('returns history for a note with version numbers', function (): void {
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    // Create a nook
    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'History Test']));
    expect($create['status'])->toBe(200);
    $nookId = json_decode($create['body'], true)['nook']['id'];

    // Create a note
    $noteRes = App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode([
        'title' => 'Original Title',
        'content' => 'Original content',
    ]));
    expect($noteRes['status'])->toBe(200);
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Update the note twice
    App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'Second Title',
        'content' => 'Updated content',
    ]));
    App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'Third Title',
        'content' => 'Final content',
    ]));

    // Fetch history
    $historyRes = App::handle('GET', "/api/nooks/$nookId/notes/$noteId/history", $headers);
    expect($historyRes['status'])->toBe(200);

    $data = json_decode($historyRes['body'], true);
    expect($data['history'])->toBeArray();
    expect(count($data['history']))->toBe(3);

    // Most recent first
    expect($data['history'][0]['version'])->toBe(3);
    expect($data['history'][0]['action'])->toBe('UPDATE');
    expect($data['history'][1]['version'])->toBe(2);
    expect($data['history'][1]['action'])->toBe('UPDATE');
    expect($data['history'][2]['version'])->toBe(1);
    expect($data['history'][2]['action'])->toBe('INSERT');

    // User info is present
    expect($data['history'][0]['user_id'])->toBe($userId);
    expect($data['history'][0]['user_name'])->not->toBeEmpty();
});

it('note row itself reflects current version', function (): void {
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Version Test']));
    $nookId = json_decode($create['body'], true)['nook']['id'];

    $noteRes = App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode([
        'title' => 'V1',
        'content' => '',
    ]));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Get note — should have version 1
    $get = App::handle('GET', "/api/nooks/$nookId/notes/$noteId", $headers);
    $noteData = json_decode($get['body'], true)['note'];
    expect($noteData['version'])->toBe(1);

    // Update
    App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'V2',
        'content' => 'changed',
    ]));

    $get2 = App::handle('GET', "/api/nooks/$nookId/notes/$noteId", $headers);
    $noteData2 = json_decode($get2['body'], true)['note'];
    expect($noteData2['version'])->toBe(2);
});

it('returns 409 conflict when expected_version does not match', function (): void {
    $userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Conflict Test']));
    $nookId = json_decode($create['body'], true)['nook']['id'];

    // Create a note (version 1)
    $noteRes = App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode([
        'title' => 'Conflict Note',
        'content' => 'original',
    ]));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Update it (version 2)
    App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'Updated',
        'content' => 'changed',
    ]));

    // Try to update with expected_version=1 (stale)
    $conflictRes = App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'Stale edit',
        'content' => 'should fail',
        'expected_version' => 1,
    ]));
    expect($conflictRes['status'])->toBe(409);

    $body = json_decode($conflictRes['body'], true);
    expect($body['error'])->toBe('note was edited in the meantime');
    expect($body['current_version'])->toBe(2);
    expect($body['expected_version'])->toBe(1);
});

it('allows update when expected_version matches', function (): void {
    $userId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Version OK Test']));
    $nookId = json_decode($create['body'], true)['nook']['id'];

    $noteRes = App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode([
        'title' => 'V1 Note',
        'content' => 'v1',
    ]));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Update with correct expected_version=1
    $updateRes = App::handle('PUT', "/api/nooks/$nookId/notes/$noteId", $headers, json_encode([
        'title' => 'V2 Note',
        'content' => 'v2',
        'expected_version' => 1,
    ]));
    expect($updateRes['status'])->toBe(200);

    $body = json_decode($updateRes['body'], true);
    expect($body['note']['version'])->toBe(2);
    expect($body['note']['title'])->toBe('V2 Note');
});

it('returns 403 for non-members requesting history', function (): void {
    $ownerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    $ownerHeaders = ['X-Nook-User' => $ownerId, 'X-Nook-Groups' => 'paith/notes'];
    $otherHeaders = ['X-Nook-User' => $otherId, 'X-Nook-Groups' => 'paith/notes'];

    $create = App::handle('POST', '/api/nooks', $ownerHeaders, json_encode(['name' => 'Private']));
    $nookId = json_decode($create['body'], true)['nook']['id'];

    $noteRes = App::handle('POST', "/api/nooks/$nookId/notes", $ownerHeaders, json_encode([
        'title' => 'Secret',
        'content' => '',
    ]));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Other user tries to access history
    $historyRes = App::handle('GET', "/api/nooks/$nookId/notes/$noteId/history", $otherHeaders);
    expect($historyRes['status'])->toBe(403);
});
