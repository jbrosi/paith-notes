<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Edge-case coverage for POST + PUT /notes.
 *
 * Happy paths are exercised by ApiTest; this file pins down the
 * rejection branches that aren't otherwise covered (DTO validation,
 * type-not-found, optimistic locking, attribute schema mismatch,
 * cross-nook isolation, the readwrite-vs-owner update gate).
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, userId, nookId] */
function noteTestSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Test']));
    return [$headers, $userId, json_decode($res['body'], true)['nook']['id']];
}

it('rejects creating a note with no title', function (): void {
    [$headers, , $nookId] = noteTestSetup('aaaaaaaaaaaa');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'content' => 'body without a title',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('title');
});

it('rejects creating a note with a non-uuid type_id', function (): void {
    [$headers, , $nookId] = noteTestSetup('bbbbbbbbbbbb');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'X',
        'type_id' => 'not-a-uuid',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('type_id');
});

it('rejects creating a note with a type_id that does not exist in the nook', function (): void {
    [$headers, , $nookId] = noteTestSetup('cccccccccccc');
    $missingTypeId = '99999999-9999-4999-8999-999999999999';

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'X',
        'type_id' => $missingTypeId,
    ]));
    expect($res['status'])->toBe(404);
});

it('rejects creating a note in a nook the caller is not a member of', function (): void {
    [$ownerHeaders, , $nookId] = noteTestSetup('dddddddddddd');
    [$strangerHeaders, ] = (function (): array {
        $uid = 'eeeeeeee-eeee-4eee-8eee-fffffffffffe';
        $h = ['X-Nook-User' => $uid, 'X-Nook-Groups' => 'paith/notes'];
        App::handle('GET', '/api/me', $h, '');
        return [$h, $uid];
    })();

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $strangerHeaders, json_encode([
        'title' => 'Sneak',
    ]));
    expect($res['status'])->toBe(403);
});

it('returns 409 on update when expected_version disagrees with current', function (): void {
    [$headers, , $nookId] = noteTestSetup('eeeeeeeeeeee');
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Lockable']));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'title' => 'New',
        'expected_version' => 99,
    ]));
    expect($res['status'])->toBe(409);
    $body = json_decode($res['body'], true);
    expect($body['expected_version'])->toBe(99);
    expect($body['current_version'])->toBeInt();
});

it('falls back to existing title on update when title is empty', function (): void {
    [$headers, , $nookId] = noteTestSetup('ffffffffffff');
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Original']));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // No title in the PUT body — controller should fetch existing
    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'content' => 'updated body',
    ]));
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['note']['title'])->toBe('Original');
});

it('merges incoming attributes into existing on update, with null meaning delete', function (): void {
    [$headers, , $nookId] = noteTestSetup('000000000001');

    $typeRes = App::handle('POST', "/api/nooks/{$nookId}/note-types", $headers, json_encode([
        'key' => 'page', 'label' => 'Page',
    ]));
    expect($typeRes['status'])->toBe(200, $typeRes['body']);
    $typeId = json_decode($typeRes['body'], true)['type']['id'];

    $attrA = json_decode(App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'A', 'kind' => 'text',
    ]))['body'], true)['attribute']['id'];
    $attrB = json_decode(App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'B', 'kind' => 'text',
    ]))['body'], true)['attribute']['id'];

    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Merge me',
        'type_id' => $typeId,
        'attributes' => [$attrA => 'aval', $attrB => 'bval'],
    ]));
    expect($noteRes['status'])->toBe(200);
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    // Update: change A, delete B by setting null
    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_encode([
        'attributes' => [$attrA => 'aval-2', $attrB => null],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $attrs = json_decode($res['body'], true)['note']['attributes'];
    expect($attrs[$attrA])->toBe('aval-2');
    expect(array_key_exists($attrB, $attrs))->toBeFalse();
});

it('lets a readwrite member edit their own notes but not someone elses', function (): void {
    // owner creates nook + invites a readwrite collaborator
    $pdo = test_pdo();
    [$ownerHeaders, $ownerId, $nookId] = noteTestSetup('000000000002');

    $collabId = 'eeeeeeee-eeee-4eee-8eee-222222222222';
    $collabHeaders = ['X-Nook-User' => $collabId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $collabHeaders, '');

    // Promote collab to readwrite directly in DB (avoids the email-invite dance)
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:n, :u, 'readwrite') on conflict (nook_id, user_id) do update set role = excluded.role")
        ->execute([':n' => $nookId, ':u' => $collabId]);

    // Owner creates a note
    $ownerNoteId = json_decode(App::handle('POST', "/api/nooks/{$nookId}/notes", $ownerHeaders, json_encode(['title' => 'Owner']))['body'], true)['note']['id'];

    // Collab creates their own
    $collabNoteId = json_decode(App::handle('POST', "/api/nooks/{$nookId}/notes", $collabHeaders, json_encode(['title' => 'Collab']))['body'], true)['note']['id'];

    // Collab can edit their own — 200
    $ownEdit = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$collabNoteId}", $collabHeaders, json_encode(['title' => 'Collab v2']));
    expect($ownEdit['status'])->toBe(200);

    // Collab cannot edit owner's note — 403
    $foreignEdit = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$ownerNoteId}", $collabHeaders, json_encode(['title' => 'Hijack']));
    expect($foreignEdit['status'])->toBe(403);
});
