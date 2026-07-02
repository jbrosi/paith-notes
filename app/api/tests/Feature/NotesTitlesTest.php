<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * GET /nooks/{nookId}/notes/titles — lean projection for the global
 * notes-search dropdown. Pins down: limited columns, default+max
 * limit, case-insensitive title-substring filter, member-only.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: array<string, string>, 1: string} */
function titlesSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'T']));
    return [$headers, json_decode($res['body'], true)['nook']['id']];
}

it('returns a lean note projection (id+title+type_id only)', function (): void {
    [$headers, $nookId] = titlesSetup('111111111111');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'First']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Second']));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles", $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['notes'])->toHaveCount(2);

    // Lean shape — none of the full-list join columns appear.
    // nook_id + version are inline so the AI can act on results without
    // a second get_note round-trip.
    foreach ($body['notes'] as $n) {
        expect(array_keys($n))->toBe(['id', 'nook_id', 'title', 'type_id', 'version']);
        expect($n['nook_id'])->toBe($nookId);
        expect($n['version'])->toBeGreaterThanOrEqual(0);
    }
});

it('defaults to 20 results and caps at 50', function (): void {
    [$headers, $nookId] = titlesSetup('222222222222');
    for ($i = 0; $i < 25; $i++) {
        App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => "Note {$i}"]));
    }

    // Default cap: 20
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles", $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBe(20);

    // Explicit limit honoured up to max 50
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles?limit=10", $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBe(10);

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles?limit=9999", $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBeLessThanOrEqual(50);
});

it('filters by case-insensitive title substring when q is supplied', function (): void {
    [$headers, $nookId] = titlesSetup('333333333333');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Apple Pie']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Banana Bread']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'apple cider']));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles?q=" . urlencode('apple'), $headers, '');
    expect($res['status'])->toBe(200);
    $titles = array_column(json_decode($res['body'], true)['notes'], 'title');
    expect($titles)->toContain('Apple Pie');
    expect($titles)->toContain('apple cider');
    expect($titles)->not->toContain('Banana Bread');
});

it('returns 403 when the caller is not a member of the nook', function (): void {
    [, $nookId] = titlesSetup('444444444444');
    $strangerHeaders = ['X-Nook-User' => 'eeeeeeee-eeee-4eee-8eee-fffffffffffe', 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $strangerHeaders, '');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles", $strangerHeaders, '');
    expect($res['status'])->toBe(403);
});

it('does not collide with /notes/{noteId} (static route wins over dynamic)', function (): void {
    // Regression: route ordering between /notes/titles and /notes/{noteId}.
    [$headers, $nookId] = titlesSetup('555555555555');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'X']));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/titles", $headers, '');
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['notes'])->toBeArray();
});
