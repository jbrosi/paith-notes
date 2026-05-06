<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\Auth\SessionCrypto;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Shared\Db\DatabaseUrl;
use Paith\Notes\Shared\Db\GlobalSchema;

function test_pdo(): \PDO
{
    // Prefer DATABASE_TEST_URL to avoid wiping the dev database.
    // If not set, derive one by appending _test to the DATABASE_URL dbname.
    $databaseUrl = getenv('DATABASE_TEST_URL');
    if (!is_string($databaseUrl) || $databaseUrl === '') {
        $baseUrl = getenv('DATABASE_URL');
        if (is_string($baseUrl) && $baseUrl !== '') {
            // Append _test to the database name
            $parts = parse_url($baseUrl);
            $dbName = ltrim((string)($parts['path'] ?? ''), '/');
            if ($dbName !== '' && !str_ends_with($dbName, '_test')) {
                $databaseUrl = preg_replace('#/[^/]+$#', '/' . $dbName . '_test', $baseUrl);
            } else {
                $databaseUrl = $baseUrl;
            }
        }
    }
    if (!is_string($databaseUrl) || $databaseUrl === '') {
        throw new \RuntimeException('DATABASE_TEST_URL or DATABASE_URL must be set');
    }

    // Auto-create the test database if it doesn't exist
    $testParts = parse_url($databaseUrl);
    $testDbName = ltrim((string)($testParts['path'] ?? ''), '/');
    if ($testDbName !== '') {
        $adminUrl = preg_replace('#/[^/]+$#', '/postgres', $databaseUrl);
        if (is_string($adminUrl)) {
            try {
                $adminCfg = DatabaseUrl::toPdoConfig($adminUrl);
                $admin = new \PDO($adminCfg['dsn'], $adminCfg['user'], $adminCfg['pass'], [
                    \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                    \PDO::ATTR_TIMEOUT => 2,
                ]);
                $check = $admin->query("SELECT 1 FROM pg_database WHERE datname = " . $admin->quote($testDbName));
                if (!$check || !$check->fetchColumn()) {
                    $admin->exec('CREATE DATABASE ' . $testDbName);
                }
            } catch (\Throwable $e) {
                // Best effort — if we can't create it, the next connection will fail with a clear error
            }
        }
    }

    // Point DATABASE_URL to the test DB so App::handle() also uses it
    putenv('DATABASE_URL=' . $databaseUrl);

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
