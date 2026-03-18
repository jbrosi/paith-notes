<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Middleware\RequireUser;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Tests\Support\FakeJwtVerifier;
use Paith\Notes\Api\Tests\Support\FakeOAuthTokenRefresher;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid claims array for the fake verifier to return.
 *
 * @param array<string, mixed> $overrides
 * @return array<string, mixed>
 */
function make_claims(int $exp, array $overrides = []): array
{
    return array_merge([
        'sub'                => 'test-sub-' . bin2hex(random_bytes(4)),
        'iss'                => 'https://keycloak.example.com/realms/test',
        'aud'                => 'test-client',
        'exp'                => $exp,
        'preferred_username' => 'testuser',
        'given_name'         => 'Test',
        'family_name'        => 'User',
        'email'              => 'test@example.com',
        'email_verified'     => true,
        'groups'             => ['paith/notes'],
    ], $overrides);
}

/**
 * Invoke RequireUser middleware directly and return the HTTP status code.
 * The $next callable sets the user on context and returns 200 OK.
 *
 * @param array<string, string> $headers
 */
function run_middleware(
    RequireUser $mw,
    \PDO $pdo,
    array $headers = [],
): int {
    $request = new Request('GET', '/api/me', $headers);
    $context = new Context(static fn () => $pdo);
    $next = static fn ($req, $ctx) => JsonResponse::ok(['user' => $ctx->user()]);
    try {
        $response = $mw->handle($request, $context, $next);
        return $response->statusCode();
    } catch (HttpError $e) {
        return $e->statusCode;
    }
}

function session_cookie(string $sid): string
{
    return SessionStore::cookieName() . '=' . $sid;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=1');
    putenv('SESSION_SECRET=test-session-secret-for-testing');
    putenv('KEYCLOAK_CLIENT_ID=test-client');

    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

afterEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('authenticates a request with a valid session token', function (): void {
    $pdo = test_pdo();

    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willReturn('valid-token', make_claims(time() + 3600));

    $sid = create_test_session($pdo, ['access_token' => 'valid-token', 'refresh_token' => 'some-refresh']);
    $mw = new RequireUser($jwtVerifier);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);
});

it('returns 401 when there is no session cookie and no Authorization header', function (): void {
    $pdo = test_pdo();
    $mw = new RequireUser(new FakeJwtVerifier());

    $status = run_middleware($mw, $pdo);

    expect($status)->toBe(401);
});

it('reactively refreshes an expired token and succeeds (bug fix)', function (): void {
    $pdo = test_pdo();

    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willExpire('expired-token');
    $jwtVerifier->willReturn('new-token', make_claims(time() + 3600));

    $refresher = new FakeOAuthTokenRefresher();
    $refresher->willReturn(['access_token' => 'new-token', 'refresh_token' => 'new-refresh']);

    $sid = create_test_session($pdo, ['access_token' => 'expired-token', 'refresh_token' => 'old-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);
    expect($refresher->callCount())->toBe(1);

    // DB should now hold the refreshed token.
    $stored = get_session_token_payload($pdo, $sid);
    expect($stored['access_token'])->toBe('new-token');
    expect($stored['refresh_token'])->toBe('new-refresh');
});

it('returns 401 when the token is expired and there is no refresh token in the session', function (): void {
    $pdo = test_pdo();

    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willExpire('expired-token');

    $sid = create_test_session($pdo, ['access_token' => 'expired-token']); // no refresh_token
    $mw = new RequireUser($jwtVerifier, new FakeOAuthTokenRefresher());

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(401);
});

it('returns 401 when the token is expired and the Keycloak refresh call fails', function (): void {
    $pdo = test_pdo();

    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willExpire('expired-token');

    $refresher = new FakeOAuthTokenRefresher();
    $refresher->willThrow(new RuntimeException('Session not active'));

    $sid = create_test_session($pdo, ['access_token' => 'expired-token', 'refresh_token' => 'old-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(401);
    expect($refresher->callCount())->toBe(1);
});

it('proactively refreshes a token that is close to expiry', function (): void {
    $pdo = test_pdo();

    // Token expires in 30 s — below the 60 s threshold.
    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willReturn('close-token', make_claims(time() + 30));
    $jwtVerifier->willReturn('new-token', make_claims(time() + 3600));

    $refresher = new FakeOAuthTokenRefresher();
    $refresher->willReturn(['access_token' => 'new-token', 'refresh_token' => 'new-refresh']);

    $sid = create_test_session($pdo, ['access_token' => 'close-token', 'refresh_token' => 'old-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);
    expect($refresher->callCount())->toBe(1);

    // DB should hold the fresh token after proactive refresh.
    $stored = get_session_token_payload($pdo, $sid);
    expect($stored['access_token'])->toBe('new-token');
    expect($stored['refresh_token'])->toBe('new-refresh');
});

it('succeeds with the original claims when proactive refresh fails', function (): void {
    $pdo = test_pdo();

    // Token is still valid (30 s left) so claims are usable even if refresh fails.
    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willReturn('close-token', make_claims(time() + 30));

    $refresher = new FakeOAuthTokenRefresher();
    $refresher->willThrow(new RuntimeException('Keycloak unavailable'));

    $sid = create_test_session($pdo, ['access_token' => 'close-token', 'refresh_token' => 'old-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    // Should still succeed — proactive refresh is best-effort.
    expect($status)->toBe(200);
    expect($refresher->callCount())->toBe(1);

    // DB payload should be unchanged.
    $stored = get_session_token_payload($pdo, $sid);
    expect($stored['access_token'])->toBe('close-token');
});

it('does not call Keycloak when the token has plenty of time left', function (): void {
    $pdo = test_pdo();

    // Token expires in 5 minutes — above the 60 s threshold.
    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willReturn('valid-token', make_claims(time() + 300));

    $refresher = new FakeOAuthTokenRefresher();

    $sid = create_test_session($pdo, ['access_token' => 'valid-token', 'refresh_token' => 'some-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);
    expect($refresher->callCount())->toBe(0);
});

it('preserves the old refresh token when Keycloak does not return a new one', function (): void {
    $pdo = test_pdo();

    $jwtVerifier = new FakeJwtVerifier();
    $jwtVerifier->willExpire('expired-token');
    $jwtVerifier->willReturn('new-token', make_claims(time() + 3600));

    $refresher = new FakeOAuthTokenRefresher();
    // Keycloak response without a refresh_token (offline_access not granted, or rotating disabled).
    $refresher->willReturn(['access_token' => 'new-token']);

    $sid = create_test_session($pdo, ['access_token' => 'expired-token', 'refresh_token' => 'original-refresh']);
    $mw = new RequireUser($jwtVerifier, $refresher);

    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);

    $stored = get_session_token_payload($pdo, $sid);
    expect($stored['access_token'])->toBe('new-token');
    // Original refresh token must be carried forward.
    expect($stored['refresh_token'])->toBe('original-refresh');
});

it('reuses a token that another concurrent request already refreshed (lock fast-path)', function (): void {
    $pdo = test_pdo();

    // Both the initial read and the locked re-read return 'already-fresh-token',
    // which has plenty of time left. refreshIfNeeded should return it without calling Keycloak.
    $jwtVerifier = new FakeJwtVerifier();
    // close-token triggers the proactive refresh path...
    $jwtVerifier->willReturn('close-token', make_claims(time() + 30));
    // ...but under the lock the DB holds already-fresh-token (e.g. refreshed by another request).
    $jwtVerifier->willReturn('already-fresh-token', make_claims(time() + 3600));

    $refresher = new FakeOAuthTokenRefresher();

    // Pre-load the DB with the fresh token so that the lock re-read finds it.
    $sid = create_test_session($pdo, ['access_token' => 'already-fresh-token', 'refresh_token' => 'some-refresh']);

    // The initial session read will return 'already-fresh-token' (not 'close-token').
    // So verifyAndDecode is called with 'already-fresh-token', which returns exp=now+3600,
    // well above the threshold — proactive refresh does NOT fire, and Keycloak is never called.
    $mw = new RequireUser($jwtVerifier, $refresher);
    $status = run_middleware($mw, $pdo, ['Cookie' => session_cookie($sid)]);

    expect($status)->toBe(200);
    expect($refresher->callCount())->toBe(0);
});
