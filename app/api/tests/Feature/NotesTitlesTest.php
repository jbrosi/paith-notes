<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * GET /nooks/{nookId}/notes?lean=1 — the lean projection used by the
 * global notes-search dropdown. Verifies: limited columns, default+max
 * limit, case-insensitive title+content substring filter, heading
 * match search + inline heading_matches, member-only access.
 *
 * File name is legacy — this was `/notes/titles` before we unified
 * both endpoints onto `/notes?lean=1`. Kept the file so `git log
 * --follow` still tracks the coverage history.
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

it('returns a lean note projection (id/nook_id/title/type_id/version)', function (): void {
    [$headers, $nookId] = titlesSetup('111111111111');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'First']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Second']));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1", $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['notes'])->toHaveCount(2);

    // Lean shape — none of the full-list join columns appear.
    // nook_id + version are inline so the AI (and the dropdown) can
    // act on results without a second get_note round-trip.
    foreach ($body['notes'] as $n) {
        expect(array_keys($n))->toBe(['id', 'nook_id', 'title', 'type_id', 'version']);
        expect($n['nook_id'])->toBe($nookId);
        expect($n['version'])->toBeGreaterThanOrEqual(0);
    }
});

it('honours ?limit and caps at 200', function (): void {
    [$headers, $nookId] = titlesSetup('222222222222');
    for ($i = 0; $i < 25; $i++) {
        App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => "Note {$i}"]));
    }

    // Explicit limit honoured
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1&limit=10", $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBe(10);

    // Well over max stays within 200
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1&limit=9999", $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBeLessThanOrEqual(200);
});

it('filters by case-insensitive title substring when q is supplied', function (): void {
    [$headers, $nookId] = titlesSetup('333333333333');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Apple Pie']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'Banana Bread']));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'apple cider']));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1&q=" . urlencode('apple'), $headers, '');
    expect($res['status'])->toBe(200);
    $titles = array_column(json_decode($res['body'], true)['notes'], 'title');
    expect($titles)->toContain('Apple Pie');
    expect($titles)->toContain('apple cider');
    expect($titles)->not->toContain('Banana Bread');
});

it('matches content, not just title, when q is supplied', function (): void {
    // Regression — the nav search dropdown hits this endpoint. Users
    // expect a paragraph-only word to surface the containing note,
    // otherwise they can't find a note without remembering its title.
    [$headers, $nookId] = titlesSetup('555555555555');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Unrelated', 'content' => 'the dog said brumm brumm',
    ]));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Another', 'content' => 'nothing special',
    ]));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1&q=" . urlencode('brumm'), $headers, '');
    expect($res['status'])->toBe(200);
    $titles = array_column(json_decode($res['body'], true)['notes'], 'title');
    expect($titles)->toContain('Unrelated');
    expect($titles)->not->toContain('Another');
});

it('returns heading_matches inline for the dropdown section', function (): void {
    // The dropdown expects heading_matches from the same lean call so
    // it doesn't have to race a separate list() request.
    [$headers, $nookId] = titlesSetup('666666666666');
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Manual',
        'content' => "prose\n\n## Startup sequence\n\nsteps",
    ]));
    App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Sibling', 'content' => 'boring text',
    ]));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1&q=" . urlencode('startup'), $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    $titles = array_column($body['notes'], 'title');
    // Note with the matching heading is in `notes` (heading is part of
    // content, so content-LIKE catches it).
    expect($titles)->toContain('Manual');
    expect($titles)->not->toContain('Sibling');
    // And heading_matches carries the deep-link data for the section.
    expect($body['heading_matches'])->not->toBeEmpty();
    expect($body['heading_matches'][0]['note_title'])->toBe('Manual');
    expect($body['heading_matches'][0]['text'])->toContain('Startup');
});

it('returns 403 when the caller is not a member of the nook', function (): void {
    [, $nookId] = titlesSetup('444444444444');
    $strangerHeaders = ['X-Nook-User' => 'eeeeeeee-eeee-4eee-8eee-fffffffffffe', 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $strangerHeaders, '');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes?lean=1", $strangerHeaders, '');
    expect($res['status'])->toBe(403);
});
