<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Edge-case coverage for note type + attribute validation:
 * - parent self-reference
 * - parent across nooks
 * - duplicate type keys
 * - attribute name uniqueness across inheritance
 * - kind enum
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: array<string, string>, 1: string} */
function nookTestSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Test']));
    return [$headers, json_decode($res['body'], true)['nook']['id']];
}

function createType(array $headers, string $nookId, string $key, string $label, ?string $parentId = null): string
{
    $body = ['key' => $key, 'label' => $label];
    if ($parentId !== null) {
        $body['parent_id'] = $parentId;
    }
    $res = App::handle('POST', "/api/nooks/{$nookId}/note-types", $headers, json_encode($body));
    expect($res['status'])->toBe(200);
    return json_decode($res['body'], true)['type']['id'];
}

it('rejects setting parent_id to self on update', function (): void {
    [$headers, $nookId] = nookTestSetup('a11111111111');
    $typeId = createType($headers, $nookId, 'self-parent', 'Self');

    $res = App::handle('PUT', "/api/nooks/{$nookId}/note-types/{$typeId}", $headers, json_encode([
        'key' => 'self-parent',
        'label' => 'Self',
        'parent_id' => $typeId,
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('parent_id');
});

it('rejects parent_id that lives in a different nook', function (): void {
    [$headersA, $nookA] = nookTestSetup('a22222222222');
    [$headersB, $nookB] = nookTestSetup('b22222222222');
    $foreignTypeId = createType($headersB, $nookB, 'foreign', 'Foreign');

    $res = App::handle('POST', "/api/nooks/{$nookA}/note-types", $headersA, json_encode([
        'key' => 'child',
        'label' => 'Child',
        'parent_id' => $foreignTypeId,
    ]));
    expect($res['status'])->toBe(404);
    expect(json_decode($res['body'], true)['error'])->toContain('parent');
});

it('rejects creating a duplicate attribute name on the same type', function (): void {
    [$headers, $nookId] = nookTestSetup('a33333333333');
    $typeId = createType($headers, $nookId, 'page', 'Page');

    $first = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'Body',
        'kind' => 'text',
    ]));
    expect($first['status'])->toBe(200);

    $dup = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'Body',
        'kind' => 'text',
    ]));
    expect($dup['status'])->toBe(409);
});

it('rejects a child attribute name that collides with the parents inherited attribute', function (): void {
    [$headers, $nookId] = nookTestSetup('a44444444444');
    $parent = createType($headers, $nookId, 'parent-t', 'Parent');
    App::handle('POST', "/api/nooks/{$nookId}/note-types/{$parent}/attributes", $headers, json_encode([
        'name' => 'Shared',
        'kind' => 'text',
    ]));
    $child = createType($headers, $nookId, 'child-t', 'Child', $parent);

    $res = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$child}/attributes", $headers, json_encode([
        'name' => 'Shared',
        'kind' => 'text',
    ]));
    expect($res['status'])->toBe(409);
    expect(json_decode($res['body'], true)['error'])->toContain('inherited');
});

it('rejects a parent attribute that would collide with a descendants existing attribute', function (): void {
    [$headers, $nookId] = nookTestSetup('a55555555555');
    $parent = createType($headers, $nookId, 'p-collision', 'Parent');
    $child = createType($headers, $nookId, 'c-collision', 'Child', $parent);
    App::handle('POST', "/api/nooks/{$nookId}/note-types/{$child}/attributes", $headers, json_encode([
        'name' => 'OwnedByChild',
        'kind' => 'text',
    ]));

    $res = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$parent}/attributes", $headers, json_encode([
        'name' => 'OwnedByChild',
        'kind' => 'text',
    ]));
    expect($res['status'])->toBe(409);
});

it('rejects an unknown attribute kind', function (): void {
    [$headers, $nookId] = nookTestSetup('a66666666666');
    $typeId = createType($headers, $nookId, 'page', 'Page');

    $res = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'X',
        'kind' => 'not-a-real-kind',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('kind must be one of');
});

it('auto-slugifies the attribute key from name when not provided', function (): void {
    [$headers, $nookId] = nookTestSetup('a77777777777');
    $typeId = createType($headers, $nookId, 'page', 'Page');

    $res = App::handle('POST', "/api/nooks/{$nookId}/note-types/{$typeId}/attributes", $headers, json_encode([
        'name' => 'Some Mixed Case Name',
        'kind' => 'text',
    ]));
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['attribute']['key'])->toBe('some-mixed-case-name');
});

it('rejects deleting a type that still has child types', function (): void {
    [$headers, $nookId] = nookTestSetup('a88888888888');
    $parent = createType($headers, $nookId, 'parent-d', 'Parent');
    createType($headers, $nookId, 'child-d', 'Child', $parent);

    $res = App::handle('DELETE', "/api/nooks/{$nookId}/note-types/{$parent}", $headers, '');
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('child types');
});
