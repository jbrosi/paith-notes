<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\Auth\SessionCrypto;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Shared\Db\DatabaseUrl;
use Paith\Notes\Shared\Db\GlobalSchema;

function test_pdo(): \PDO
{
    $databaseUrl = getenv('DATABASE_URL');
    if (!is_string($databaseUrl)) {
        $databaseUrl = '';
    }
    $cfg = DatabaseUrl::toPdoConfig($databaseUrl);

    return new \PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
        \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        \PDO::ATTR_TIMEOUT => 2,
    ]);
}

function ensure_global_schema(\PDO $pdo): void
{
    GlobalSchema::ensure($pdo);
}

/**
 * Create a user + session in the test DB and return the session ID (cookie value).
 *
 * @param array<string, mixed> $tokenPayload  e.g. ['access_token' => 'tok', 'refresh_token' => 'ref']
 */
function create_test_session(\PDO $pdo, array $tokenPayload, int $ttlSeconds = 3600): string
{
    // Ensure SESSION_SECRET is set for crypto.
    if ((string)getenv('SESSION_SECRET') === '') {
        putenv('SESSION_SECRET=test-session-secret-for-testing');
    }

    // Create a minimal user row.
    $userId = 'aaaaaaaa-bbbb-4ccc-8ddd-' . str_pad((string)random_int(0, 999999999999), 12, '0', STR_PAD_LEFT);
    $stmt = $pdo->prepare(
        "insert into global.users (id, first_name, last_name) values (:id, 'Test', 'User') on conflict (id) do nothing"
    );
    $stmt->execute([':id' => $userId]);

    $crypto = SessionCrypto::fromEnv();
    $encrypted = $crypto->encrypt((string)json_encode($tokenPayload));

    return SessionStore::createSession($pdo, $userId, $encrypted, $ttlSeconds);
}

/**
 * Read and decrypt the token payload currently stored in the DB for a session.
 *
 * @return array<string, mixed>
 */
function get_session_token_payload(\PDO $pdo, string $sessionId): array
{
    $session = SessionStore::getSession($pdo, $sessionId);
    $crypto = SessionCrypto::fromEnv();
    $json = $crypto->decrypt($session['token_encrypted']);
    $payload = json_decode($json, true);
    return is_array($payload) ? $payload : [];
}
