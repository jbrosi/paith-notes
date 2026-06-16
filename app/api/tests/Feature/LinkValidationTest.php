<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Edge-case coverage for the link + predicate validation paths.
 * The happy-path is covered by ApiTest; this file exercises the
 * "rejects bad input" branches that aren't otherwise exercised.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/**
 * @return array{0: array<string, string>, 1: string}
 *   [headers, nookId]
 */
function makeNook(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Test']));
    return [$headers, json_decode($res['body'], true)['nook']['id']];
}

function makeNote(array $headers, string $nookId, string $title): string
{
    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => $title]));
    return json_decode($res['body'], true)['note']['id'];
}

function makePredicate(array $headers, string $nookId, string $key, bool $supportsStart = false, bool $supportsEnd = false): string
{
    $res = App::handle('POST', "/api/nooks/{$nookId}/link-predicates", $headers, json_encode([
        'key' => $key,
        'forward_label' => "{$key}-fwd",
        'reverse_label' => "{$key}-rev",
        'supports_start_date' => $supportsStart,
        'supports_end_date' => $supportsEnd,
    ]));
    expect($res['status'])->toBe(200);
    return json_decode($res['body'], true)['predicate']['id'];
}

it('rejects creating a predicate with the reserved relates_to key', function (): void {
    [$headers, $nookId] = makeNook('111111111111');

    $res = App::handle('POST', "/api/nooks/{$nookId}/link-predicates", $headers, json_encode([
        'key' => 'relates_to',
        'forward_label' => 'r',
        'reverse_label' => 'r',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('relates_to');
});

it('rejects creating a duplicate predicate key', function (): void {
    [$headers, $nookId] = makeNook('222222222222');
    makePredicate($headers, $nookId, 'duplicate-key');

    $res = App::handle('POST', "/api/nooks/{$nookId}/link-predicates", $headers, json_encode([
        'key' => 'duplicate-key',
        'forward_label' => 'a',
        'reverse_label' => 'b',
    ]));
    expect($res['status'])->toBe(409);
});

it('rejects linking a note to itself', function (): void {
    [$headers, $nookId] = makeNook('333333333333');
    $noteId = makeNote($headers, $nookId, 'Self');
    $predId = makePredicate($headers, $nookId, 'self-link-pred');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$noteId}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => $noteId,
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('itself');
});

it('rejects start_date > end_date on a link', function (): void {
    [$headers, $nookId] = makeNook('444444444444');
    $a = makeNote($headers, $nookId, 'A');
    $b = makeNote($headers, $nookId, 'B');
    $predId = makePredicate($headers, $nookId, 'dated-pred', true, true);

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$a}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => $b,
        'start_date' => '2026-12-01',
        'end_date' => '2026-01-01',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('start_date must be <= end_date');
});

it('rejects providing start_date when the predicate does not support it', function (): void {
    [$headers, $nookId] = makeNook('555555555555');
    $a = makeNote($headers, $nookId, 'A');
    $b = makeNote($headers, $nookId, 'B');
    // supportsStart=false, supportsEnd=false
    $predId = makePredicate($headers, $nookId, 'no-dates-pred');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$a}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => $b,
        'start_date' => '2026-01-01',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('start_date');
});

it('rejects malformed dates with a clear error', function (): void {
    [$headers, $nookId] = makeNook('666666666666');
    $a = makeNote($headers, $nookId, 'A');
    $b = makeNote($headers, $nookId, 'B');
    $predId = makePredicate($headers, $nookId, 'dated-pred-2', true, true);

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$a}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => $b,
        'start_date' => '12/31/2025',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('YYYY-MM-DD');
});

it('rejects creating a link with a non-uuid target_note_id', function (): void {
    [$headers, $nookId] = makeNook('777777777777');
    $a = makeNote($headers, $nookId, 'A');
    $predId = makePredicate($headers, $nookId, 'p');

    $res = App::handle('POST', "/api/nooks/{$nookId}/notes/{$a}/links", $headers, json_encode([
        'predicate_id' => $predId,
        'target_note_id' => 'not-a-uuid',
    ]));
    expect($res['status'])->toBe(400);
});
