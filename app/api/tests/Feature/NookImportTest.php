<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;
use Paith\Notes\Api\Http\Controller\NookExportController;
use Paith\Notes\Api\Http\Controller\NookImportController;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/**
 * Build a small fixture nook: type "page" with a "body" text attribute,
 * two notes that link to each other.
 *
 * @return array{0: array<string, string>, 1: string, 2: array<string, string>}
 *   [headers, nookId, ids] where ids has keys: type, attr, predicate, note1, note2
 */
function buildFixtureNook(string $userIdPart, string $nookName): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$userIdPart}";
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => $nookName]));
    $nookId = json_decode($res['body'], true)['nook']['id'];

    // Create type
    $typeRes = App::handle('POST', "/api/nooks/{$nookId}/note-types", $headers, json_encode([
        'key' => 'page',
        'label' => 'Page',
    ]));
    $typeId = json_decode($typeRes['body'], true)['type']['id'];

    // Add a text attribute
    $attrRes = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'key' => 'body',
        'name' => 'Body',
        'kind' => 'text',
    ]));
    $attrId = json_decode($attrRes['body'], true)['attribute']['id'];

    // Create a link predicate
    $predRes = App::handle('POST', "/api/nooks/{$nookId}/link-predicates", $headers, json_encode([
        'key' => 'relates-to',
        'forward_label' => 'relates to',
        'reverse_label' => 'related from',
    ]));
    $predId = json_decode($predRes['body'], true)['predicate']['id'];

    // Two notes
    $n1Res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'First',
        'content' => 'first body',
        'type_id' => $typeId,
        'attributes' => [$attrId => 'value-one'],
    ]));
    $note1Id = json_decode($n1Res['body'], true)['note']['id'];

    $n2Res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Second',
        'content' => "links to [[note:{$note1Id}]] inline",
        'type_id' => $typeId,
        'attributes' => [$attrId => 'value-two'],
    ]));
    $note2Id = json_decode($n2Res['body'], true)['note']['id'];

    // Create a link
    App::handle('POST', "/api/nooks/{$nookId}/notes/{$note1Id}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => $note2Id,
    ]));

    return [$headers, $nookId, [
        'user' => $userId,
        'type' => $typeId,
        'attr' => $attrId,
        'predicate' => $predId,
        'note1' => $note1Id,
        'note2' => $note2Id,
    ]];
}

function exportNookToTempZip(\PDO $pdo, string $nookId): string
{
    $stats = ['notes' => 0, 'types' => 0, 'attributes' => 0, 'links' => 0, 'predicates' => 0, 'files' => 0];
    return NookExportController::exportNookZip($pdo, $nookId, null, $stats);
}

it('imports a nook as a new nook with fresh ids', function (): void {
    $pdo = test_pdo();
    [$headers, $sourceNookId, $ids] = buildFixtureNook('aaaaaaaaaaaa', 'Source');

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    $newNookId = NookImportController::importAsNewNook($pdo, $zipPath, $ids['user'], 'Imported');
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    expect($newNookId)->not()->toBe($sourceNookId);

    // Counts in new nook match the source
    $typeCount = (int) $pdo->query("select count(*) from global.note_types where nook_id = " . $pdo->quote($newNookId))->fetchColumn();
    $sourceTypeCount = (int) $pdo->query("select count(*) from global.note_types where nook_id = " . $pdo->quote($sourceNookId))->fetchColumn();
    expect($typeCount)->toBe($sourceTypeCount);

    $noteCount = (int) $pdo->query("select count(*) from global.notes where nook_id = " . $pdo->quote($newNookId))->fetchColumn();
    $sourceNoteCount = (int) $pdo->query("select count(*) from global.notes where nook_id = " . $pdo->quote($sourceNookId))->fetchColumn();
    expect($noteCount)->toBe($sourceNoteCount);

    $linkCount = (int) $pdo->query("select count(*) from global.note_links where nook_id = " . $pdo->quote($newNookId))->fetchColumn();
    $sourceLinkCount = (int) $pdo->query("select count(*) from global.note_links where nook_id = " . $pdo->quote($sourceNookId))->fetchColumn();
    expect($linkCount)->toBe($sourceLinkCount);

    // None of the source note ids exist in the new nook
    $srcNoteIds = $pdo->query("select id from global.notes where nook_id = " . $pdo->quote($sourceNookId))->fetchAll(PDO::FETCH_COLUMN);
    foreach ($srcNoteIds as $oldId) {
        $exists = (int) $pdo->query("select count(*) from global.notes where nook_id = " . $pdo->quote($newNookId) . " and id = " . $pdo->quote($oldId))->fetchColumn();
        expect($exists)->toBe(0);
    }
});

it('rewrites note links to the new nook ids', function (): void {
    $pdo = test_pdo();
    [$headers, $sourceNookId, $ids] = buildFixtureNook('bbbbbbbbbbbb', 'Source');

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    $newNookId = NookImportController::importAsNewNook($pdo, $zipPath, $ids['user']);
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    // Every link in the new nook must point at notes that live in the new nook
    $links = $pdo->query("select source_note_id, target_note_id from global.note_links where nook_id = " . $pdo->quote($newNookId))->fetchAll(PDO::FETCH_ASSOC);
    expect(count($links))->toBeGreaterThan(0);

    foreach ($links as $l) {
        $srcNook = $pdo->query("select nook_id from global.notes where id = " . $pdo->quote($l['source_note_id']))->fetchColumn();
        $tgtNook = $pdo->query("select nook_id from global.notes where id = " . $pdo->quote($l['target_note_id']))->fetchColumn();
        expect($srcNook)->toBe($newNookId);
        expect($tgtNook)->toBe($newNookId);
    }
});

it('rewrites same-nook content references to the new ids', function (): void {
    $pdo = test_pdo();
    [$headers, $sourceNookId, $ids] = buildFixtureNook('cccccccccccc', 'Source');

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    $newNookId = NookImportController::importAsNewNook($pdo, $zipPath, $ids['user']);
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    // The "Second" note in the new nook should still link to *some* note in the new nook,
    // and not to the original note's UUID.
    $row = $pdo->query("select id, content from global.notes where nook_id = " . $pdo->quote($newNookId) . " and title = 'Second'")
        ->fetch(PDO::FETCH_ASSOC);
    expect($row)->not()->toBeFalse();
    expect($row['content'])->not()->toContain($ids['note1']);
    expect($row['content'])->toMatch('/\[\[note:[0-9a-f-]{36}\]\]/');

    // Extract the embedded uuid and confirm it belongs to a note in the new nook
    if (preg_match('/\[\[note:([0-9a-f-]{36})\]\]/', $row['content'], $m)) {
        $refNookId = $pdo->query("select nook_id from global.notes where id = " . $pdo->quote($m[1]))->fetchColumn();
        expect($refNookId)->toBe($newNookId);
    }
});

it('does not modify other nooks in the database', function (): void {
    $pdo = test_pdo();
    [$ownerHeaders, $sourceNookId, $ownerIds] = buildFixtureNook('dddddddddddd', 'Source');

    // Snapshot another, unrelated nook owned by a different user
    [$otherHeaders, $otherNookId, $otherIds] = buildFixtureNook('111111111111', 'Bystander');

    $otherBefore = $pdo->query("select id, title, content from global.notes where nook_id = " . $pdo->quote($otherNookId) . " order by id")->fetchAll(PDO::FETCH_ASSOC);

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    NookImportController::importAsNewNook($pdo, $zipPath, $ownerIds['user']);
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    $otherAfter = $pdo->query("select id, title, content from global.notes where nook_id = " . $pdo->quote($otherNookId) . " order by id")->fetchAll(PDO::FETCH_ASSOC);
    expect($otherAfter)->toBe($otherBefore);
});

it('creates the new nook with the owner as a member', function (): void {
    $pdo = test_pdo();
    [$headers, $sourceNookId, $ids] = buildFixtureNook('eeeeeeeeeeee', 'Source');

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    $newNookId = NookImportController::importAsNewNook($pdo, $zipPath, $ids['user'], 'My Imported Copy');
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    $row = $pdo->query("select name, owner_id from global.nooks where id = " . $pdo->quote($newNookId))->fetch(PDO::FETCH_ASSOC);
    expect($row['name'])->toBe('My Imported Copy');
    expect($row['owner_id'])->toBe($ids['user']);

    $role = $pdo->query("select role from global.nook_members where nook_id = " . $pdo->quote($newNookId) . " and user_id = " . $pdo->quote($ids['user']))->fetchColumn();
    expect($role)->toBe('owner');
});

it('falls back to the source nook name when none is provided', function (): void {
    $pdo = test_pdo();
    [$headers, $sourceNookId, $ids] = buildFixtureNook('ffffffffffff', 'Original Name');

    $zipPath = exportNookToTempZip($pdo, $sourceNookId);
    $newNookId = NookImportController::importAsNewNook($pdo, $zipPath, $ids['user']);
    if (file_exists($zipPath)) {
        unlink($zipPath);
    }

    $name = $pdo->query("select name from global.nooks where id = " . $pdo->quote($newNookId))->fetchColumn();
    expect($name)->toBe('Original Name');
});
