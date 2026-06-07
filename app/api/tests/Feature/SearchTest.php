<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * GET /api/search behaviour: empty/whitespace q, AND vs OR mode,
 * limit clamping, cross-nook membership isolation, heading matches.
 *
 * Ranking is exercised qualitatively (top result for an exact-ish
 * match) rather than as a tight numeric assertion — pg_trgm scores
 * shift across postgres minor versions and aren't worth pinning.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: array<string, string>, 1: string} [headers, nookId] */
function searchSetupNook(string $idPart, string $name = 'Search'): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => $name]));
    return [$headers, json_decode($res['body'], true)['nook']['id']];
}

function searchCreateNote(array $headers, string $nookId, string $title, string $content = ''): string
{
    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => $title,
        'content' => $content,
    ]));
    return json_decode($res['body'], true)['note']['id'];
}

it('returns an empty result set for an empty q without hitting the DB clause', function (): void {
    [$headers] = searchSetupNook('111111111111');

    $res = App::handle('GET', '/api/search?q=', $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['notes'])->toBe([]);
});

it('returns an empty result set for whitespace-only q', function (): void {
    [$headers] = searchSetupNook('222222222222');

    $res = App::handle('GET', '/api/search?q=' . urlencode('   '), $headers, '');
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['notes'])->toBe([]);
});

it('finds a note by title substring within an accessible nook', function (): void {
    [$headers, $nookId] = searchSetupNook('333333333333');
    $noteId = searchCreateNote($headers, $nookId, 'Apple Pie Recipe');
    searchCreateNote($headers, $nookId, 'Unrelated');

    $res = App::handle('GET', '/api/search?q=' . urlencode('apple'), $headers, '');
    expect($res['status'])->toBe(200);
    $ids = array_column(json_decode($res['body'], true)['notes'], 'id');
    expect($ids)->toContain($noteId);
    expect(count($ids))->toBe(1);
});

it('AND mode requires every term to match, OR mode only one', function (): void {
    [$headers, $nookId] = searchSetupNook('444444444444');
    searchCreateNote($headers, $nookId, 'Apple Pie');
    searchCreateNote($headers, $nookId, 'Banana Bread');
    searchCreateNote($headers, $nookId, 'Apple Banana Salad');

    // AND: only "Apple Banana Salad" contains both
    $and = App::handle('GET', '/api/search?q=' . urlencode('apple banana') . '&search_mode=and', $headers, '');
    expect($and['status'])->toBe(200);
    $andTitles = array_column(json_decode($and['body'], true)['notes'], 'title');
    expect($andTitles)->toBe(['Apple Banana Salad']);

    // OR: all three match at least one term
    $or = App::handle('GET', '/api/search?q=' . urlencode('apple banana') . '&search_mode=or', $headers, '');
    $orTitles = array_column(json_decode($or['body'], true)['notes'], 'title');
    expect(count($orTitles))->toBe(3);
});

it('does not leak notes from nooks the caller is not a member of', function (): void {
    // User A's nook has the haystack note
    [$headersA, $nookA] = searchSetupNook('555555555555', 'A');
    searchCreateNote($headersA, $nookA, 'Secret Apple Plans');

    // User B has their own nook with no matching content
    [$headersB] = searchSetupNook('666666666666', 'B');

    $res = App::handle('GET', '/api/search?q=' . urlencode('apple'), $headersB, '');
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['notes'])->toBe([]);
});

it('matches content (not just title) via LIKE', function (): void {
    [$headers, $nookId] = searchSetupNook('777777777777');
    $noteId = searchCreateNote($headers, $nookId, 'Innocuous Title', 'the body mentions watermelon explicitly');

    $res = App::handle('GET', '/api/search?q=' . urlencode('watermelon'), $headers, '');
    expect(array_column(json_decode($res['body'], true)['notes'], 'id'))->toContain($noteId);
});

it('honours the limit query param and clamps it to a 1..50 range', function (): void {
    [$headers, $nookId] = searchSetupNook('888888888888');
    // Seven notes that all match "common"
    for ($i = 0; $i < 7; $i++) {
        searchCreateNote($headers, $nookId, "Common note {$i}");
    }

    $res = App::handle('GET', '/api/search?q=' . urlencode('common') . '&limit=3', $headers, '');
    expect(count(json_decode($res['body'], true)['notes']))->toBe(3);

    // Out-of-range limits clamp instead of erroring
    $tooBig = App::handle('GET', '/api/search?q=' . urlencode('common') . '&limit=9999', $headers, '');
    expect($tooBig['status'])->toBe(200);
    expect(count(json_decode($tooBig['body'], true)['notes']))->toBeLessThanOrEqual(50);

    $tooSmall = App::handle('GET', '/api/search?q=' . urlencode('common') . '&limit=0', $headers, '');
    expect($tooSmall['status'])->toBe(200);
    // limit=0 clamps to 1
    expect(count(json_decode($tooSmall['body'], true)['notes']))->toBe(1);
});

it('matches a double-quoted phrase as a single term across word boundaries', function (): void {
    [$headers, $nookId] = searchSetupNook('999999999999');
    $hit = searchCreateNote($headers, $nookId, 'Apple Pie Recipe');
    searchCreateNote($headers, $nookId, 'Apple Banana Pie');

    // "apple pie" should NOT match the second note (banana between the words)
    $res = App::handle('GET', '/api/search?q=' . urlencode('"apple pie"'), $headers, '');
    $ids = array_column(json_decode($res['body'], true)['notes'], 'id');
    expect($ids)->toContain($hit);
    expect(count($ids))->toBe(1);
});

it('returns heading_matches when the query matches a heading in note content', function (): void {
    [$headers, $nookId] = searchSetupNook('aaaaaaaaaaaa');
    $noteId = searchCreateNote(
        $headers,
        $nookId,
        'Has headings',
        "intro paragraph\n\n## A peculiar subsection\n\nbody"
    );

    $res = App::handle('GET', '/api/search?q=' . urlencode('peculiar'), $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['heading_matches'])->not->toBeEmpty();
    expect($body['heading_matches'][0]['note_id'])->toBe($noteId);
    expect($body['heading_matches'][0]['text'])->toContain('peculiar');
});
