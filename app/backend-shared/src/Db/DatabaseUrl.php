<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

use RuntimeException;

final class DatabaseUrl
{
    /**
     * @return array{dsn: string, user: string, pass: string}
     */
    public static function toPdoConfig(string $databaseUrl): array
    {
        $databaseUrl = trim($databaseUrl);
        if ($databaseUrl === '') {
            throw new RuntimeException('DATABASE_URL is not set');
        }

        $parts = parse_url($databaseUrl);
        if ($parts === false) {
            throw new RuntimeException('DATABASE_URL is invalid');
        }

        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        if (!in_array($scheme, ['postgres', 'postgresql'], true)) {
            throw new RuntimeException('DATABASE_URL must start with postgresql://');
        }

        $host = (string)($parts['host'] ?? '');
        $port = (int)($parts['port'] ?? 5432);
        $user = (string)($parts['user'] ?? '');
        $pass = (string)($parts['pass'] ?? '');
        $dbName = ltrim((string)($parts['path'] ?? ''), '/');

        if ($host === '' || $user === '' || $dbName === '') {
            throw new RuntimeException('DATABASE_URL must include host, user, and database name');
        }

        $query = (string)($parts['query'] ?? '');
        $params = [];
        if ($query !== '') {
            parse_str($query, $params);
        }

        $dsnParams = [
            'host' => $host,
            'port' => (string)$port,
            'dbname' => $dbName,
        ];

        foreach (['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslcrl', 'application_name', 'options'] as $key) {
            if (!array_key_exists($key, $params)) {
                continue;
            }
            $value = $params[$key];
            if (!is_scalar($value)) {
                continue;
            }
            $str = trim((string)$value);
            if ($str === '') {
                continue;
            }
            $dsnParams[$key] = $str;
        }

        $dsn = 'pgsql:' . self::buildDsnParams($dsnParams);

        return [
            'dsn' => $dsn,
            'user' => $user,
            'pass' => $pass,
        ];
    }

    /**
     * @param array<string, string> $params
     */
    private static function buildDsnParams(array $params): string
    {
        $chunks = [];
        foreach ($params as $k => $v) {
            $key = trim((string)$k);
            if ($key === '') {
                continue;
            }
            $val = self::sanitizeDsnValue($v);
            $chunks[] = sprintf('%s=%s', $key, $val);
        }
        return implode(';', $chunks);
    }

    private static function sanitizeDsnValue(string $value): string
    {
        // DSN params are separated by semicolons; strip to prevent breaking the DSN.
        return str_replace([';', "\n", "\r"], '', $value);
    }
}
