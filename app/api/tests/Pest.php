<?php
declare(strict_types=1);

use Paith\Notes\Shared\Db\GlobalSchema;

function test_pdo(): \PDO
{
    $databaseUrl = getenv('DATABASE_URL');
    if (!is_string($databaseUrl) || $databaseUrl === '') {
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

    return new \PDO($dsn, $user, $pass, [
        \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        \PDO::ATTR_TIMEOUT => 2,
    ]);
}

function ensure_global_schema(\PDO $pdo): void
{
    GlobalSchema::ensure($pdo);
}
