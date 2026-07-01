<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Feature tests for the navigation primitives that pair with /toc:
 *   • GET /nooks/{n}/notes/{id}/part?from=&to=  — half-open char-range read
 *   • GET /nooks/{n}/notes/{id}/search?q=...    — find-in-note with positions
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string, 2: string} [headers, nookId, noteId] */
function partTestSetup(string $idPart, string $content): array
{
    $userId = "cdcdcdcd-cdcd-4cdc-8cdc-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'part-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];
    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode([
        'title' => 'Part Test',
        'content' => $content,
    ]));
    $noteId = (string)json_decode($note['body'], true)['note']['id'];
    return [$headers, $nookId, $noteId];
}

// ─── /part ────────────────────────────────────────────────────────────

it('part returns the half-open char-range slice', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('111111111111', '0123456789ABCDEF');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/part?from=2&to=6", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    // [2, 6) → chars at indices 2,3,4,5 → "2345"
    expect($body['part']['content'])->toBe('2345');
    expect($body['part']['from'])->toBe(2);
    expect($body['part']['to'])->toBe(6);
    expect($body['part']['truncated'])->toBeFalse();
});

it('part clamps out-of-range bounds and flags truncated', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('222222222222', '0123456789'); // 10 chars

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/part?from=5&to=999", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);
    expect($body['part']['content'])->toBe('56789');
    expect($body['part']['to'])->toBe(10);
    expect($body['part']['truncated'])->toBeTrue();
});

it('part handles multibyte content correctly (chars, not bytes)', function (): void {
    // 'héllo' — 'é' is 2 bytes in UTF-8 but 1 char. from=0 to=3 should
    // return 'hél' (3 chars), not 'h' followed by half an é.
    [$headers, $nookId, $noteId] = partTestSetup('333333333333', 'héllo wörld');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/part?from=0&to=3", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['part']['content'])->toBe('hél');
});

it('part rejects negative or non-numeric from/to', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('444444444444', 'abc');

    $bad = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/part?from=abc&to=2", $headers, '');
    expect($bad['status'])->toBe(400);
    expect(json_decode($bad['body'], true)['error'])->toContain('from');
});

it('part rejects to < from', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('555555555555', 'abcdef');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/part?from=5&to=2", $headers, '');
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('>= from');
});

// ─── /search ──────────────────────────────────────────────────────────

it('search returns every match position with surrounding context', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('666666666666', "foo bar foo baz foo qux");

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=foo", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true)['search'];

    expect($body['total_matches'])->toBe(3);
    expect($body['returned_matches'])->toBe(3);
    expect($body['truncated'])->toBeFalse();
    expect(array_column($body['matches'], 'position'))->toBe([0, 8, 16]);
    expect($body['matches'][0]['end'])->toBe(3);
});

it('search is case-insensitive by default and case-sensitive when asked', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('777777777777', "Foo FOO foo");

    $ci = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=foo", $headers, '');
    expect(json_decode($ci['body'], true)['search']['total_matches'])->toBe(3);

    $cs = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=foo&case_sensitive=1", $headers, '');
    expect(json_decode($cs['body'], true)['search']['total_matches'])->toBe(1);
});

it('search honors context_chars and includes the surrounding text', function (): void {
    $content = 'before-context-here-NEEDLE-after-context-here';
    [$headers, $nookId, $noteId] = partTestSetup('888888888888', $content);

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=NEEDLE&context_chars=10", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);
    $m = json_decode($res['body'], true)['search']['matches'][0];

    // 10 chars before + NEEDLE + 10 chars after
    expect($m['context'])->toContain('NEEDLE');
    expect(mb_strlen($m['context']))->toBeLessThanOrEqual(strlen('NEEDLE') + 20);
});

it('search rejects empty q', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('999999999999', 'abc');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=", $headers, '');
    expect($res['status'])->toBe(400);
});

it('search caps returned matches and flags truncated', function (): void {
    // 60 occurrences of "x" → match cap is 50 → returned=50, total=60, truncated=true
    $content = str_repeat('x ', 60);
    [$headers, $nookId, $noteId] = partTestSetup('aaaaaaaaaaa1', $content);

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=x", $headers, '');
    $body = json_decode($res['body'], true)['search'];
    expect($body['total_matches'])->toBe(60);
    expect($body['returned_matches'])->toBe(50);
    expect($body['truncated'])->toBeTrue();
});

it('search returns 0 matches cleanly when the needle is absent', function (): void {
    [$headers, $nookId, $noteId] = partTestSetup('bbbbbbbbbbb2', 'hello world');

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/search?q=NOPE", $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true)['search'];
    expect($body['total_matches'])->toBe(0);
    expect($body['matches'])->toBe([]);
});
