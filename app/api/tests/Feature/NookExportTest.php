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

function createUserAndNook(): array
{
    $userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    // Auto-create user + personal nook
    App::handle('GET', '/api/me', $headers, '');

    // Create a dedicated test nook
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Export Test']));
    $nookId = json_decode($res['body'], true)['nook']['id'];

    return [$userId, $headers, $nookId];
}

it('exports a nook as a zip download', function (): void {
    [$userId, $headers, $nookId] = createUserAndNook();

    // Create a note
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Test Note',
        'content' => 'Hello world',
    ]));
    expect($noteRes['status'])->toBe(200);

    // Export
    $exportRes = App::handle('GET', "/api/nooks/{$nookId}/export", $headers, '');
    expect($exportRes['status'])->toBe(200);

    // The body might be empty since FileResponse streams from disk,
    // but status should be 200 and Content-Type should be set
    $contentType = $exportRes['headers']['Content-Type'] ?? '';
    expect($contentType)->toBe('application/zip');
});

it('rejects export for non-owners', function (): void {
    [$ownerId, $ownerHeaders, $nookId] = createUserAndNook();

    // Create another user
    $otherUserId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    $otherHeaders = [
        'X-Nook-User' => $otherUserId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $otherHeaders, '');

    // Try to export (not a member, should fail)
    $res = App::handle('GET', "/api/nooks/{$nookId}/export", $otherHeaders, '');
    expect($res['status'])->toBe(403);
});

it('creates a backup note after export', function (): void {
    [$userId, $headers, $nookId] = createUserAndNook();

    // Create some notes
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Note 1', 'content' => 'one']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Note 2', 'content' => 'two']));

    // Export
    App::handle('GET', "/api/nooks/{$nookId}/export", $headers, '');

    // List notes — should now include a backup note
    $listRes = App::handle('GET', "/api/nooks/{$nookId}/notes?q=Backup", $headers, '');
    $listData = json_decode($listRes['body'], true);
    $notes = $listData['notes'] ?? [];

    $backupNotes = array_filter($notes, fn($n) => str_starts_with($n['title'] ?? '', 'Backup'));
    expect(count($backupNotes))->toBeGreaterThanOrEqual(1);
});

it('excludes backup notes from subsequent exports', function (): void {
    [$userId, $headers, $nookId] = createUserAndNook();

    // Create a note + export (creates backup note)
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Real Note']));
    App::handle('GET', "/api/nooks/{$nookId}/export", $headers, '');

    // Export again
    $pdo = test_pdo();
    $stats = ['notes' => 0, 'types' => 0, 'attributes' => 0, 'links' => 0, 'predicates' => 0, 'files' => 0];

    // Find backup type to exclude
    $backupType = $pdo->prepare("select id from global.note_types where nook_id = :nook_id and key = 'nook-backup'");
    $backupType->execute([':nook_id' => $nookId]);
    $backupTypeId = $backupType->fetchColumn();

    $zipPath = \Paith\Notes\Api\Http\Controller\NookExportController::exportNookZip($pdo, $nookId, $backupTypeId ?: null, $stats);

    // Only the real note should be in the export, not the backup
    expect($stats['notes'])->toBe(1);

    // Cleanup
    if (file_exists($zipPath)) unlink($zipPath);
});
