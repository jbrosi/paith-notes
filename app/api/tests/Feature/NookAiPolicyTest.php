<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/**
 * Feature tests for the per-nook AI policy: owner-controlled `ai_mode`
 * setting + the `EnforceNookAiPolicy` middleware that blocks AI actor
 * calls on nooks set to 'disabled'.
 *
 * Coverage:
 *   • PUT /api/nooks/{id} accepts ai_mode (owner only, validated enum)
 *   • GET /api/nooks returns ai_mode per nook
 *   • Middleware blocks AI tool calls on disabled nooks (403)
 *   • Human users always pass regardless of ai_mode
 *   • Cross-nook search excludes disabled nooks
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

/** @return array{0: array<string, string>, 1: string} [headers, nookId] */
function aiPolicySetup(string $idPart): array
{
    $userId = "dededede-dede-4ded-8ded-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $nook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'policy-test']));
    $nookId = (string)json_decode($nook['body'], true)['nook']['id'];
    return [$headers, $nookId];
}

// ─── ai_mode field round-trips through GET + PUT ──────────────────────

it('GET /api/nooks returns ai_mode for each nook (default approve_all)', function (): void {
    [$headers] = aiPolicySetup('aaaaaaaaaaaa');

    $res = App::handle('GET', '/api/nooks', $headers, '');
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['nooks'])->toBeArray()->not->toBeEmpty();
    foreach ($body['nooks'] as $n) {
        expect($n)->toHaveKey('ai_mode');
        expect($n['ai_mode'])->toBe('approve_all');
    }
});

it('owner can set ai_mode via PUT /api/nooks/{id}', function (): void {
    [$headers, $nookId] = aiPolicySetup('bbbbbbbbbbbb');

    foreach (['auto_reads', 'disabled', 'approve_all'] as $mode) {
        $res = App::handle('PUT', "/api/nooks/{$nookId}", $headers, json_encode([
            'name' => 'policy-test',
            'ai_mode' => $mode,
        ]));
        expect($res['status'])->toBe(200, "setting {$mode}: " . $res['body']);
        expect(json_decode($res['body'], true)['nook']['ai_mode'])->toBe($mode);
    }
});

it('rejects an unknown ai_mode value with 400', function (): void {
    [$headers, $nookId] = aiPolicySetup('cccccccccccc');

    $res = App::handle('PUT', "/api/nooks/{$nookId}", $headers, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'wide_open',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('ai_mode');
});

it('non-owner cannot change ai_mode (403)', function (): void {
    // Owner sets up the nook
    [$ownerHeaders, $nookId] = aiPolicySetup('dddddddddddd');

    // Stranger joins via invite simulation — easier: just try as a stranger;
    // requireOwner will fail before the membership check matters.
    $strangerHeaders = ['X-Nook-User' => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $strangerHeaders, '');

    $res = App::handle('PUT', "/api/nooks/{$nookId}", $strangerHeaders, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'auto_reads',
    ]));
    expect($res['status'])->toBe(403);
});

// ─── middleware enforces 'disabled' for AI actor ──────────────────────

it('AI actor is blocked on a disabled nook (any tool, 403)', function (): void {
    [$ownerHeaders, $nookId] = aiPolicySetup('111111111111');

    // Owner disables AI on this nook
    App::handle('PUT', "/api/nooks/{$nookId}", $ownerHeaders, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'disabled',
    ]));

    // Simulate an AI tool call (read)
    $aiHeaders = $ownerHeaders + ['X-Nook-Actor' => 'ai'];
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes", $aiHeaders, '');
    expect($res['status'])->toBe(403);
    expect(json_decode($res['body'], true)['error'])->toContain('disabled by its owner');
});

it('AI actor is blocked on writes too (POST/PUT/DELETE/PATCH)', function (): void {
    [$ownerHeaders, $nookId] = aiPolicySetup('222222222222');
    App::handle('PUT', "/api/nooks/{$nookId}", $ownerHeaders, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'disabled',
    ]));

    $aiHeaders = $ownerHeaders + ['X-Nook-Actor' => 'ai'];
    $res = App::handle('POST', "/api/nooks/{$nookId}/notes", $aiHeaders, json_encode(['title' => 'x']));
    expect($res['status'])->toBe(403);
});

it('human user is NOT blocked on a disabled nook', function (): void {
    [$ownerHeaders, $nookId] = aiPolicySetup('333333333333');
    App::handle('PUT', "/api/nooks/{$nookId}", $ownerHeaders, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'disabled',
    ]));

    // No X-Nook-Actor header → defaults to 'user' in RequireUser middleware.
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes", $ownerHeaders, '');
    expect($res['status'])->toBe(200);
});

it('explicit X-Nook-Actor: user is NOT blocked on a disabled nook', function (): void {
    [$ownerHeaders, $nookId] = aiPolicySetup('444444444444');
    App::handle('PUT', "/api/nooks/{$nookId}", $ownerHeaders, json_encode([
        'name' => 'policy-test',
        'ai_mode' => 'disabled',
    ]));

    $userHeaders = $ownerHeaders + ['X-Nook-Actor' => 'user'];
    $res = App::handle('GET', "/api/nooks/{$nookId}/notes", $userHeaders, '');
    expect($res['status'])->toBe(200);
});

it('AI actor passes when ai_mode is approve_all or auto_reads', function (): void {
    [$ownerHeaders, $nookId] = aiPolicySetup('555555555555');
    $aiHeaders = $ownerHeaders + ['X-Nook-Actor' => 'ai'];

    foreach (['approve_all', 'auto_reads'] as $mode) {
        App::handle('PUT', "/api/nooks/{$nookId}", $ownerHeaders, json_encode([
            'name' => 'policy-test',
            'ai_mode' => $mode,
        ]));
        $res = App::handle('GET', "/api/nooks/{$nookId}/notes", $aiHeaders, '');
        expect($res['status'])->toBe(200, "{$mode}: " . $res['body']);
    }
});

it('non-nook-scoped routes are not blocked even for disabled nook owner', function (): void {
    [$ownerHeaders] = aiPolicySetup('666666666666');
    $aiHeaders = $ownerHeaders + ['X-Nook-Actor' => 'ai'];

    // /api/nooks (list) has no nookId in the path → middleware no-ops.
    $res = App::handle('GET', '/api/nooks', $aiHeaders, '');
    expect($res['status'])->toBe(200);
});

// ─── cross-nook search excludes disabled nooks ────────────────────────

it('cross-nook search excludes notes from disabled nooks', function (): void {
    // Owner creates two nooks, drops a note with the same keyword in each.
    [$headers, $nookA] = aiPolicySetup('777777777777');
    $nookB = (string)json_decode(
        App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'nook-b']))['body'],
        true,
    )['nook']['id'];

    App::handle('POST', "/api/nooks/{$nookA}/notes", $headers, json_encode([
        'title' => 'findme nook a', 'content' => 'apple',
    ]));
    App::handle('POST', "/api/nooks/{$nookB}/notes", $headers, json_encode([
        'title' => 'findme nook b', 'content' => 'apple',
    ]));

    // Baseline: both notes returned.
    $before = App::handle('GET', '/api/search?q=apple', $headers, '');
    $beforeNooks = array_unique(array_column(json_decode($before['body'], true)['notes'], 'nook_id'));
    expect($beforeNooks)->toContain($nookA);
    expect($beforeNooks)->toContain($nookB);

    // Disable AI on nook B.
    App::handle('PUT', "/api/nooks/{$nookB}", $headers, json_encode([
        'name' => 'nook-b',
        'ai_mode' => 'disabled',
    ]));

    // Cross-nook search now excludes nook B regardless of actor — the
    // exclusion is intrinsic to the SQL, not actor-gated.
    $after = App::handle('GET', '/api/search?q=apple', $headers, '');
    $afterNooks = array_unique(array_column(json_decode($after['body'], true)['notes'], 'nook_id'));
    expect($afterNooks)->toContain($nookA);
    expect($afterNooks)->not->toContain($nookB);
});
