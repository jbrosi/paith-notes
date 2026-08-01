<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/*
 * Pin down: schema mutations (note_types + type_attributes) are
 * owner-only. readwrite collaborators can edit notes and attach
 * files but can't reshape the type schema they depend on.
 *
 * Regression coverage for the policy clarified during the
 * generated_image feature work — keeps schema stable when nook
 * ownership is shared with non-owner collaborators.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    test_reset_state($pdo);
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/**
 * @return array{
 *     ownerHeaders: array<string, string>,
 *     collabHeaders: array<string, string>,
 *     nookId: string,
 *     baseTypeId: string,
 * }
 */
function schemaShare(): array
{
    $pdo = test_pdo();

    $ownerHeaders = ['X-Nook-User' => '11111111-1111-4111-8111-111111111111', 'X-Nook-Groups' => 'paith/notes'];
    $collabHeaders = ['X-Nook-User' => '22222222-2222-4222-8222-222222222222', 'X-Nook-Groups' => 'paith/notes'];

    App::handle('GET', '/api/me', $ownerHeaders, '');
    App::handle('GET', '/api/me', $collabHeaders, '');

    $nookRes = App::handle('POST', '/api/nooks', $ownerHeaders, json_str(['name' => 'Shared']));
    $nookId = json_body($nookRes)['nook']['id'];

    // Add collaborator as readwrite directly via DB (skips the email-invite dance)
    $pdo->prepare(
        "insert into global.nook_members (nook_id, user_id, role) values (:n, :u, 'readwrite') "
        . "on conflict (nook_id, user_id) do update set role = excluded.role"
    )->execute([':n' => $nookId, ':u' => $collabHeaders['X-Nook-User']]);

    // Hit /note-types as the owner so the default base/file/etc. types get seeded.
    $list = App::handle('GET', "/api/nooks/{$nookId}/note-types", $ownerHeaders, '');
    $types = json_body($list)['types'];
    $baseTypeId = '';
    foreach ($types as $t) {
        if ($t['key'] === 'base') {
            $baseTypeId = $t['id'];
            break;
        }
    }
    expect($baseTypeId)->not->toBe('');

    return [
        'ownerHeaders' => $ownerHeaders,
        'collabHeaders' => $collabHeaders,
        'nookId' => $nookId,
        'baseTypeId' => $baseTypeId,
    ];
}

it('owner can create a new note type', function (): void {
    $s = schemaShare();
    $res = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types",
        $s['ownerHeaders'],
        json_str(['key' => 'recipe', 'label' => 'Recipe']),
    );
    expect($res['status'])->toBe(200, $res['body']);
});

it('readwrite collaborator cannot create a note type', function (): void {
    $s = schemaShare();
    $res = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types",
        $s['collabHeaders'],
        json_str(['key' => 'recipe', 'label' => 'Recipe']),
    );
    expect($res['status'])->toBe(403);
    expect(json_body($res)['error'])->toContain('owner');
});

it('readwrite collaborator cannot update a note type', function (): void {
    $s = schemaShare();
    // Owner creates a type
    $created = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types",
        $s['ownerHeaders'],
        json_str(['key' => 'recipe', 'label' => 'Recipe']),
    );
    $typeId = json_body($created)['type']['id'];

    // Collab can't rename it
    $res = App::handle(
        'PUT',
        "/api/nooks/{$s['nookId']}/note-types/{$typeId}",
        $s['collabHeaders'],
        json_str(['key' => 'recipe', 'label' => 'Renamed']),
    );
    expect($res['status'])->toBe(403);
});

it('readwrite collaborator cannot delete a note type', function (): void {
    $s = schemaShare();
    $created = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types",
        $s['ownerHeaders'],
        json_str(['key' => 'recipe', 'label' => 'Recipe']),
    );
    $typeId = json_body($created)['type']['id'];

    $res = App::handle(
        'DELETE',
        "/api/nooks/{$s['nookId']}/note-types/{$typeId}",
        $s['collabHeaders'],
        '',
    );
    expect($res['status'])->toBe(403);
});

it('readwrite collaborator cannot add a type attribute', function (): void {
    $s = schemaShare();
    $res = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types/{$s['baseTypeId']}/attributes",
        $s['collabHeaders'],
        json_str(['name' => 'Body', 'kind' => 'text']),
    );
    expect($res['status'])->toBe(403);
});

it('readwrite collaborator cannot update or delete an attribute', function (): void {
    $s = schemaShare();
    // Owner adds an attribute first
    $created = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/note-types/{$s['baseTypeId']}/attributes",
        $s['ownerHeaders'],
        json_str(['name' => 'Body', 'kind' => 'text']),
    );
    expect($created['status'])->toBe(200, $created['body']);
    $attrId = json_body($created)['attribute']['id'];

    $put = App::handle(
        'PUT',
        "/api/nooks/{$s['nookId']}/note-types/{$s['baseTypeId']}/attributes/{$attrId}",
        $s['collabHeaders'],
        json_str(['name' => 'Body Renamed', 'kind' => 'text']),
    );
    expect($put['status'])->toBe(403);

    $del = App::handle(
        'DELETE',
        "/api/nooks/{$s['nookId']}/note-types/{$s['baseTypeId']}/attributes/{$attrId}",
        $s['collabHeaders'],
        '',
    );
    expect($del['status'])->toBe(403);
});

it('readwrite collaborator can still create and edit notes (schema lockdown is schema-only)', function (): void {
    $s = schemaShare();
    // Sanity check: the new policy doesn't accidentally block normal
    // note operations. Collab creates a note → 200.
    $res = App::handle(
        'POST',
        "/api/nooks/{$s['nookId']}/notes",
        $s['collabHeaders'],
        json_str(['title' => 'Notes still work for collaborators']),
    );
    expect($res['status'])->toBe(200, $res['body']);
});
