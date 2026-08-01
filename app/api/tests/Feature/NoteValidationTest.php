<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/*
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
    test_reset_state($pdo);
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, userId, nookId] */
function noteTestSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_str(['name' => 'Test']));
    return [$headers, $userId, json_body($res)['nook']['id']];
}

it('rejects creating a note with no title', function (): void {
    [$headers, , $nookId] = noteTestSetup('aaaaaaaaaaaa');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str([
        'content' => 'body without a title',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('title');
});

it('rejects creating a note with a non-uuid type_id', function (): void {
    [$headers, , $nookId] = noteTestSetup('bbbbbbbbbbbb');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str([
        'title' => 'X',
        'type_id' => 'not-a-uuid',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('type_id');
});

it('rejects creating a note with a type_id that does not exist in the nook', function (): void {
    [$headers, , $nookId] = noteTestSetup('cccccccccccc');
    $missingTypeId = '99999999-9999-4999-8999-999999999999';

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str([
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

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $strangerHeaders, json_str([
        'title' => 'Sneak',
    ]));
    expect($res['status'])->toBe(403);
});

it('returns 409 on update when expected_version disagrees with current', function (): void {
    [$headers, , $nookId] = noteTestSetup('eeeeeeeeeeee');
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str(['title' => 'Lockable']));
    $noteId = json_body($noteRes)['note']['id'];

    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_str([
        'title' => 'New',
        'expected_version' => 99,
    ]));
    expect($res['status'])->toBe(409);
    $body = json_body($res);
    expect($body['expected_version'])->toBe(99);
    expect($body['current_version'])->toBeInt();
});

it('falls back to existing title on update when title is empty', function (): void {
    [$headers, , $nookId] = noteTestSetup('ffffffffffff');
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str(['title' => 'Original']));
    $noteId = json_body($noteRes)['note']['id'];

    // No title in the PUT body — controller should fetch existing
    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_str([
        'content' => 'updated body',
    ]));
    expect($res['status'])->toBe(200);
    expect(json_body($res)['note']['title'])->toBe('Original');
});

it('merges incoming attributes into existing on update, with null meaning delete', function (): void {
    [$headers, , $nookId] = noteTestSetup('000000000001');

    $typeRes = App::handle('POST', "/api/nooks/{$nookId}/note-types", $headers, json_str([
        'key' => 'page', 'label' => 'Page',
    ]));
    expect($typeRes['status'])->toBe(200, $typeRes['body']);
    $typeId = json_body($typeRes)['type']['id'];

    $attrA = json_body_of(App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_str([
        'name' => 'A', 'kind' => 'text',
    ]))['body'])['attribute']['id'];
    $attrB = json_body_of(App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_str([
        'name' => 'B', 'kind' => 'text',
    ]))['body'])['attribute']['id'];

    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str([
        'title' => 'Merge me',
        'type_id' => $typeId,
        'attributes' => [$attrA => 'aval', $attrB => 'bval'],
    ]));
    expect($noteRes['status'])->toBe(200);
    $noteId = json_body($noteRes)['note']['id'];

    // Update: change A, delete B by setting null
    $res = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$noteId}", $headers, json_str([
        'attributes' => [$attrA => 'aval-2', $attrB => null],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $attrs = json_body($res)['note']['attributes'];
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
    $ownerNoteId = json_body_of(App::handle('POST', "/api/nooks/{$nookId}/notes", $ownerHeaders, json_str(['title' => 'Owner']))['body'])['note']['id'];

    // Collab creates their own
    $collabNoteId = json_body_of(App::handle('POST', "/api/nooks/{$nookId}/notes", $collabHeaders, json_str(['title' => 'Collab']))['body'])['note']['id'];

    // Collab can edit their own — 200
    $ownEdit = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$collabNoteId}", $collabHeaders, json_str(['title' => 'Collab v2']));
    expect($ownEdit['status'])->toBe(200);

    // Collab cannot edit owner's note — 403
    $foreignEdit = App::handle('PUT', "/api/nooks/{$nookId}/notes/{$ownerNoteId}", $collabHeaders, json_str(['title' => 'Hijack']));
    expect($foreignEdit['status'])->toBe(403);
});
