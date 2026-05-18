<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

/**
 * Helpers for safely extracting typed values from PDO FETCH_ASSOC rows.
 * Satisfies phpstan level 10 without verbose inline checks.
 */
final class Row
{
    /** @param array<mixed, mixed> $row */
    public static function str(array $row, string $key, string $default = ''): string
    {
        $v = $row[$key] ?? null;
        return is_scalar($v) ? (string)$v : $default;
    }

    /** @param array<mixed, mixed> $row */
    public static function int(array $row, string $key, int $default = 0): int
    {
        $v = $row[$key] ?? null;
        return is_scalar($v) ? (int)$v : $default;
    }

    /** @param array<mixed, mixed> $row */
    public static function nullStr(array $row, string $key): ?string
    {
        $v = $row[$key] ?? null;
        if ($v === null) {
            return null;
        }
        return is_scalar($v) ? (string)$v : null;
    }
}
