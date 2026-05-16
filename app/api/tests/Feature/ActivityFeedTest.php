<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec('delete from global.audit_data');
    $pdo->exec('delete from global.audit_meta');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

it('returns user activity across nooks', function (): void {
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];

    // Create nook + notes to generate activity
    $nookRes = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Activity Test']));
    $nookId = json_decode($nookRes['body'], true)['nook']['id'];

    App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode(['title' => 'Note A', 'content' => '']));
    App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode(['title' => 'Note B', 'content' => '']));

    $res = App::handle('GET', '/api/me/activity', $headers);
    expect($res['status'])->toBe(200);

    $data = json_decode($res['body'], true);
    expect($data['activity'])->toBeArray();
    expect(count($data['activity']))->toBeGreaterThanOrEqual(2);

    // Most recent first
    expect($data['activity'][0]['id'])->toBeGreaterThan($data['activity'][1]['id']);

    // Each entry has expected fields
    $entry = $data['activity'][0];
    expect($entry)->toHaveKeys(['id', 'version', 'action', 'table_name', 'table_id', 'nook_id', 'user_id', 'user_name', 'created_at']);
    expect($entry['user_id'])->toBe($userId);
});

it('returns nook-scoped activity for all members', function (): void {
    $ownerHeaders = ['X-Nook-User' => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'X-Nook-Groups' => 'paith/notes'];

    $nookRes = App::handle('POST', '/api/nooks', $ownerHeaders, json_encode(['name' => 'Team Nook']));
    $nookId = json_decode($nookRes['body'], true)['nook']['id'];

    App::handle('POST', "/api/nooks/$nookId/notes", $ownerHeaders, json_encode(['title' => 'Team Note', 'content' => '']));

    $res = App::handle('GET', "/api/nooks/$nookId/activity", $ownerHeaders);
    expect($res['status'])->toBe(200);

    $data = json_decode($res['body'], true);
    expect($data['activity'])->toBeArray();
    expect(count($data['activity']))->toBeGreaterThanOrEqual(1);

    // Filter by table_name — should include 'notes' entries
    $noteEntries = array_filter($data['activity'], fn($e) => $e['table_name'] === 'notes');
    expect(count($noteEntries))->toBeGreaterThanOrEqual(1);
});

it('supports cursor-based pagination with before parameter', function (): void {
    $userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];

    $nookRes = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Pagination Nook']));
    $nookId = json_decode($nookRes['body'], true)['nook']['id'];

    // Create several notes
    for ($i = 0; $i < 5; $i++) {
        App::handle('POST', "/api/nooks/$nookId/notes", $headers, json_encode(['title' => "Note $i", 'content' => '']));
    }

    // First page
    $res = App::handle('GET', '/api/me/activity?limit=3', $headers);
    $data = json_decode($res['body'], true);
    expect(count($data['activity']))->toBe(3);

    // Second page using last entry's id as cursor
    $lastId = $data['activity'][2]['id'];
    $res2 = App::handle('GET', "/api/me/activity?limit=3&before=$lastId", $headers);
    $data2 = json_decode($res2['body'], true);
    expect(count($data2['activity']))->toBeGreaterThanOrEqual(1);

    // All entries in page 2 should have id < lastId
    foreach ($data2['activity'] as $entry) {
        expect($entry['id'])->toBeLessThan($lastId);
    }
});

it('returns 403 for non-member on nook activity', function (): void {
    $ownerHeaders = ['X-Nook-User' => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'X-Nook-Groups' => 'paith/notes'];
    $otherHeaders = ['X-Nook-User' => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'X-Nook-Groups' => 'paith/notes'];

    $nookRes = App::handle('POST', '/api/nooks', $ownerHeaders, json_encode(['name' => 'Private']));
    $nookId = json_decode($nookRes['body'], true)['nook']['id'];

    $res = App::handle('GET', "/api/nooks/$nookId/activity", $otherHeaders);
    expect($res['status'])->toBe(403);
});
