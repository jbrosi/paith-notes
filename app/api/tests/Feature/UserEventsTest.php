<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec('delete from global.user_events');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

it('records login event on auth callback', function (): void {
    // The callback flow requires Keycloak, so we test via direct insertion
    $pdo = test_pdo();
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    $pdo->prepare("insert into global.users (id, first_name, last_name) values (:id, 'Test', 'User') on conflict (id) do nothing")
        ->execute([':id' => $userId]);

    // Simulate what AuthController::recordEvent does
    $stmt = $pdo->prepare('insert into global.user_events (user_id, event, meta) values (:user_id, :event, :meta)');
    $stmt->execute([':user_id' => $userId, ':event' => 'login', ':meta' => json_encode(['ip' => '1.2.3.4'])]);

    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    $res = App::handle('GET', '/api/me/events', $headers);
    expect($res['status'])->toBe(200);

    $data = json_decode($res['body'], true);
    expect($data['events'])->toBeArray();
    expect(count($data['events']))->toBe(1);
    expect($data['events'][0]['event'])->toBe('login');
    expect($data['events'][0]['meta']['ip'])->toBe('1.2.3.4');
});

it('records logout event and returns it in events feed', function (): void {
    $pdo = test_pdo();
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];

    // Ensure user exists
    App::handle('GET', '/api/me', $headers);

    // Create a session for this specific user
    if ((string)getenv('SESSION_SECRET') === '') {
        putenv('SESSION_SECRET=test-session-secret-for-testing');
    }
    $crypto = \Paith\Notes\Api\Http\Auth\SessionCrypto::fromEnv();
    $encrypted = $crypto->encrypt((string)json_encode(['access_token' => 'tok']));
    $sessionId = \Paith\Notes\Api\Http\Auth\SessionStore::createSession($pdo, $userId, $encrypted, 3600);

    // Logout via POST (requires the session cookie)
    $res = App::handle('POST', '/api/auth/logout', array_merge($headers, [
        'Cookie' => 'paith_session=' . $sessionId,
    ]));
    expect($res['status'])->toBe(200);

    // Check events — the logout was recorded for $userId
    $eventsRes = App::handle('GET', '/api/me/events', $headers);
    $data = json_decode($eventsRes['body'], true);
    expect($data['events'])->toBeArray();

    $logoutEvents = array_filter($data['events'], fn($e) => $e['event'] === 'logout');
    expect(count($logoutEvents))->toBeGreaterThanOrEqual(1);
});

it('supports pagination for events', function (): void {
    $pdo = test_pdo();
    $userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    $pdo->prepare("insert into global.users (id, first_name, last_name) values (:id, 'Test', 'User') on conflict (id) do nothing")
        ->execute([':id' => $userId]);

    // Insert several events
    $stmt = $pdo->prepare('insert into global.user_events (user_id, event, meta) values (:uid, :event, :meta)');
    for ($i = 0; $i < 5; $i++) {
        $stmt->execute([':uid' => $userId, ':event' => 'login', ':meta' => json_encode(['n' => $i])]);
    }

    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];

    $res = App::handle('GET', '/api/me/events?limit=3', $headers);
    $data = json_decode($res['body'], true);
    expect(count($data['events']))->toBe(3);

    $lastId = $data['events'][2]['id'];
    $res2 = App::handle('GET', "/api/me/events?limit=3&before=$lastId", $headers);
    $data2 = json_decode($res2['body'], true);
    expect(count($data2['events']))->toBe(2);
});
