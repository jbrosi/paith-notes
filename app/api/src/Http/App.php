<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use Paith\Notes\Shared\Env;
use PDO;
use RuntimeException;
use Throwable;

final class App
{
    public static function run(): void
    {
        $handler = static function (): void {
            static $counter = 0;

            $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
            if ($path === '/health' || $path === '/healthz') {
                header('Content-Type: application/json; charset=utf-8');
                echo json_encode([
                    'status'  => 'ok',
                    'service' => 'paith-notes',
                    'ts'      => gmdate('c'),
                    'counter' => $counter++
                ], JSON_UNESCAPED_SLASHES);
                return;
            }

            if ($path === '/api/me') {
                header('Content-Type: application/json; charset=utf-8');

                try {
                    $pdo = self::pdo();
                    $user = self::requireUser($pdo);

                    echo json_encode([
                        'status' => 'ok',
                        'user' => [
                            'id' => $user['id'],
                            'first_name' => $user['first_name'],
                            'last_name' => $user['last_name'],
                        ],
                    ], JSON_UNESCAPED_SLASHES);
                } catch (AuthError $e) {
                    http_response_code($e->statusCode);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES);
                } catch (Throwable $e) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES);
                }

                return;
            }

            if ($path === '/api/nooks' && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
                header('Content-Type: application/json; charset=utf-8');

                try {
                    $pdo = self::pdo();
                    $user = self::requireUser($pdo);

                    $stmt = $pdo->prepare("
                        select 
                            n.id, 
                            n.name, 
                            nm.role
                        from global.nooks n
                        join global.nook_members nm on nm.nook_id = n.id
                        where 
                            nm.user_id = :user_id
                        order by n.created_at desc;
                    ");
                    $stmt->execute([':user_id' => $user['id']]);
                    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

                    echo json_encode([
                        'status' => 'ok',
                        'nooks' => array_map(static fn (array $r): array => [
                            'id' => $r['id'],
                            'name' => $r['name'],
                            'role' => $r['role'],
                        ], $rows),
                    ], JSON_UNESCAPED_SLASHES);
                } catch (AuthError $e) {
                    http_response_code($e->statusCode);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES);
                } catch (Throwable $e) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES);
                }

                return;
            }

            if ($path === '/api/nooks' && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
                header('Content-Type: application/json; charset=utf-8');

                try {
                    $pdo = self::pdo();
                    $user = self::requireUser($pdo);

                    $raw = file_get_contents('php://input');
                    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : [];
                    if (!is_array($data)) {
                        $data = [];
                    }

                    $name = trim((string)($data['name'] ?? ''));
                    if ($name === '') {
                        http_response_code(400);
                        echo json_encode([
                            'status' => 'error',
                            'error' => 'name is required',
                        ], JSON_UNESCAPED_SLASHES);
                        return;
                    }

                    $pdo->beginTransaction();

                    $create = $pdo->prepare("\n                        insert into global.nooks (name, created_by)\n                        values (:name, :created_by)\n                        returning id\n                    ");
                    $create->execute([
                        ':name' => $name,
                        ':created_by' => $user['id'],
                    ]);
                    $nookId = (string)$create->fetchColumn();

                    $member = $pdo->prepare("\n                        insert into global.nook_members (nook_id, user_id, role)\n                        values (:nook_id, :user_id, 'owner')\n                        on conflict (nook_id, user_id) do update set role = excluded.role\n                    ");
                    $member->execute([
                        ':nook_id' => $nookId,
                        ':user_id' => $user['id'],
                    ]);

                    $pdo->commit();

                    echo json_encode([
                        'status' => 'ok',
                        'nook' => [
                            'id' => $nookId,
                            'name' => $name,
                            'role' => 'owner',
                        ],
                    ], JSON_UNESCAPED_SLASHES);
                } catch (AuthError $e) {
                    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
                        $pdo->rollBack();
                    }

                    http_response_code($e->statusCode);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES);
                } catch (Throwable $e) {
                    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
                        $pdo->rollBack();
                    }

                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES);
                }

                return;
            }

            if ($path === '/health/db') {
                header('Content-Type: application/json; charset=utf-8');

                $databaseUrl = Env::get('DATABASE_URL');
                if ($databaseUrl === '') {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL is not set',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $availableDrivers = [];
                try {
                    $availableDrivers = PDO::getAvailableDrivers();
                } catch (Throwable) {
                    $availableDrivers = [];
                }

                if (!in_array('pgsql', $availableDrivers, true)) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'PDO pgsql driver is not installed (pdo_pgsql extension missing)',
                        'pdo_drivers' => $availableDrivers,
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $parts = parse_url($databaseUrl);
                if ($parts === false) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL is invalid',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $host = $parts['host'] ?? '';
                $port = (int)($parts['port'] ?? 5432);
                $user = $parts['user'] ?? '';
                $pass = $parts['pass'] ?? '';
                $dbName = ltrim((string)($parts['path'] ?? ''), '/');

                if ($host === '' || $user === '' || $dbName === '') {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL must include host, user, and database name',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $host, $port, $dbName);

                try {
                    $pdo = new PDO($dsn, $user, $pass, [
                        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                        PDO::ATTR_TIMEOUT => 2,
                    ]);
                    $serverVersion = $pdo->query('select version()')->fetchColumn();

                    echo json_encode([
                        'status' => 'ok',
                        'db' => [
                            'driver' => 'pgsql',
                            'host' => $host,
                            'port' => $port,
                            'name' => $dbName,
                            'server_version' => $serverVersion,
                        ],
                    ], JSON_UNESCAPED_SLASHES);
                } catch (Throwable $e) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                        'pdo_drivers' => $availableDrivers,
                    ], JSON_UNESCAPED_SLASHES);
                }

                return;
            }

            header('Content-Type: text/plain; charset=utf-8');
            echo "Paith Notes up. Try /health\n";
        };

        while (frankenphp_handle_request($handler)) {
        }
    }

    public static function handle(string $method, string $path, array $headers = [], string $body = ''): array
    {
        $method = strtoupper($method);

        if ($path === '/api/me') {
            try {
                $pdo = self::pdo();
                $user = self::requireUser($pdo, $headers);

                return [
                    'status' => 200,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'ok',
                        'user' => [
                            'id' => $user['id'],
                            'first_name' => $user['first_name'],
                            'last_name' => $user['last_name'],
                        ],
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (AuthError $e) {
                return [
                    'status' => $e->statusCode,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (Throwable $e) {
                return [
                    'status' => 500,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            }
        }

        if ($path === '/api/nooks' && $method === 'GET') {
            try {
                $pdo = self::pdo();
                $user = self::requireUser($pdo, $headers);

                $stmt = $pdo->prepare("\n                        select \n                            n.id, \n                            n.name, \n                            nm.role\n                        from global.nooks n\n                        join global.nook_members nm on nm.nook_id = n.id\n                        where \n                            nm.user_id = :user_id\n                        order by n.created_at desc;\n                    ");
                $stmt->execute([':user_id' => $user['id']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

                return [
                    'status' => 200,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'ok',
                        'nooks' => array_map(static fn (array $r): array => [
                            'id' => $r['id'],
                            'name' => $r['name'],
                            'role' => $r['role'],
                        ], $rows),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (AuthError $e) {
                return [
                    'status' => $e->statusCode,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (Throwable $e) {
                return [
                    'status' => 500,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            }
        }

        if ($path === '/api/nooks' && $method === 'POST') {
            $pdo = null;

            try {
                $pdo = self::pdo();
                $user = self::requireUser($pdo, $headers);

                $data = $body !== '' ? json_decode($body, true) : [];
                if (!is_array($data)) {
                    $data = [];
                }

                $name = trim((string)($data['name'] ?? ''));
                if ($name === '') {
                    return [
                        'status' => 400,
                        'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                        'body' => (string)json_encode([
                            'status' => 'error',
                            'error' => 'name is required',
                        ], JSON_UNESCAPED_SLASHES),
                    ];
                }

                $pdo->beginTransaction();

                $create = $pdo->prepare("\n                        insert into global.nooks (name, created_by)\n                        values (:name, :created_by)\n                        returning id\n                    ");
                $create->execute([
                    ':name' => $name,
                    ':created_by' => $user['id'],
                ]);
                $nookId = (string)$create->fetchColumn();

                $member = $pdo->prepare("\n                        insert into global.nook_members (nook_id, user_id, role)\n                        values (:nook_id, :user_id, 'owner')\n                        on conflict (nook_id, user_id) do update set role = excluded.role\n                    ");
                $member->execute([
                    ':nook_id' => $nookId,
                    ':user_id' => $user['id'],
                ]);

                $pdo->commit();

                return [
                    'status' => 200,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'ok',
                        'nook' => [
                            'id' => $nookId,
                            'name' => $name,
                            'role' => 'owner',
                        ],
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (AuthError $e) {
                if ($pdo instanceof PDO && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }

                return [
                    'status' => $e->statusCode,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            } catch (Throwable $e) {
                if ($pdo instanceof PDO && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }

                return [
                    'status' => 500,
                    'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
                    'body' => (string)json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                    ], JSON_UNESCAPED_SLASHES),
                ];
            }
        }

        return [
            'status' => 404,
            'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
            'body' => (string)json_encode([
                'status' => 'error',
                'error' => 'not found',
            ], JSON_UNESCAPED_SLASHES),
        ];
    }

    private static function pdo(): PDO
    {
        $databaseUrl = Env::get('DATABASE_URL');
        if ($databaseUrl === '') {
            throw new RuntimeException('DATABASE_URL is not set');
        }

        $parts = parse_url($databaseUrl);
        if ($parts === false) {
            throw new RuntimeException('DATABASE_URL is invalid');
        }

        $host = $parts['host'] ?? '';
        $port = (int)($parts['port'] ?? 5432);
        $user = $parts['user'] ?? '';
        $pass = $parts['pass'] ?? '';
        $dbName = ltrim((string)($parts['path'] ?? ''), '/');

        if ($host === '' || $user === '' || $dbName === '') {
            throw new RuntimeException('DATABASE_URL must include host, user, and database name');
        }

        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $host, $port, $dbName);

        return new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 2,
        ]);
    }

    private static function requireUser(PDO $pdo, ?array $headers = null): array
    {
        $id = '';
        if (is_array($headers)) {
            $lookup = [];
            foreach ($headers as $k => $v) {
                if (!is_string($k)) {
                    continue;
                }
                $lookup[strtolower($k)] = (string)$v;
            }
            $id = trim((string)($lookup['x-nook-user'] ?? ''));
        } else {
            $id = trim((string)($_SERVER['HTTP_X_NOOK_USER'] ?? ''));
        }

        if ($id === '') {
            throw new AuthError('X-Nook-User header is required', 401);
        }

        if (!self::isUuid($id)) {
            throw new AuthError('X-Nook-User must be a UUID', 400);
        }

        $stmt = $pdo->prepare('select id, first_name, last_name from global.users where id = :id');
        $stmt->execute([':id' => $id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (is_array($user)) {
            return $user;
        }

        [$first, $last] = self::randomName();

        $ins = $pdo->prepare('insert into global.users (id, first_name, last_name) values (:id, :first_name, :last_name)');
        $ins->execute([
            ':id' => $id,
            ':first_name' => $first,
            ':last_name' => $last,
        ]);

        return [
            'id' => $id,
            'first_name' => $first,
            'last_name' => $last,
        ];
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }

    private static function randomName(): array
    {
        $first = [
            'Ava', 'Mia', 'Luna', 'Nova', 'Ivy', 'Ada', 'Zoe', 'Maya', 'Noah', 'Leo',
            'Eli', 'Theo', 'Owen', 'Finn', 'Milo', 'Aria', 'Nina', 'Sage', 'Skye', 'Remy',
        ];
        $last = [
            'Moss', 'River', 'Stone', 'Ember', 'Cedar', 'Wren', 'Fox', 'Reed', 'Bloom', 'Hearth',
            'Frost', 'Rowan', 'Pine', 'Vale', 'Brook', 'Ash', 'Sunny', 'Cloud', 'Thorn', 'Leaf',
        ];

        $f = $first[random_int(0, count($first) - 1)];
        $l = $last[random_int(0, count($last) - 1)];

        return [$f, $l];
    }
}
