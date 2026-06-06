<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

use RuntimeException;

/**
 * Helpers for safely extracting typed values from PDO FETCH_ASSOC rows.
 * Satisfies phpstan level 10 without verbose inline checks.
 *
 * Two flavours:
 *   • default-based (str / int / bool / jsonObj / nullStr / nullInt) — return
 *     a fallback value on missing or malformed cells; for fields where empty
 *     is meaningful;
 *   • require-based (requireStr / requireInt) — throw on missing or
 *     malformed cells; for required ids and similar where a missing value
 *     means the schema or query is wrong.
 */
final class Row
{
    /** @param array<array-key, mixed> $row */
    public static function str(array $row, string $key, string $default = ''): string
    {
        $v = $row[$key] ?? null;
        return is_scalar($v) ? (string)$v : $default;
    }

    /** @param array<array-key, mixed> $row */
    public static function int(array $row, string $key, int $default = 0): int
    {
        $v = $row[$key] ?? null;
        return is_scalar($v) ? (int)$v : $default;
    }

    /**
     * Postgres returns booleans as native bool through PDO by default and as
     * 't'/'f' when PDO::ATTR_STRINGIFY_FETCHES is on. Handle both.
     *
     * @param array<array-key, mixed> $row
     */
    public static function bool(array $row, string $key, bool $default = false): bool
    {
        $v = $row[$key] ?? null;
        if (is_bool($v)) {
            return $v;
        }
        if ($v === 't' || $v === 'true' || $v === 1 || $v === '1') {
            return true;
        }
        if ($v === 'f' || $v === 'false' || $v === 0 || $v === '0') {
            return false;
        }
        return $default;
    }

    /** @param array<array-key, mixed> $row */
    public static function nullStr(array $row, string $key): ?string
    {
        $v = $row[$key] ?? null;
        if ($v === null) {
            return null;
        }
        return is_scalar($v) ? (string)$v : null;
    }

    /** @param array<array-key, mixed> $row */
    public static function nullInt(array $row, string $key): ?int
    {
        $v = $row[$key] ?? null;
        if ($v === null) {
            return null;
        }
        return is_scalar($v) ? (int)$v : null;
    }

    /**
     * Decode a JSONB column. Returns empty array for null/missing/non-object.
     * JSON arrays decode to associative arrays with stringified numeric keys.
     *
     * @param array<array-key, mixed> $row
     * @return array<string, mixed>
     */
    public static function jsonObj(array $row, string $key): array
    {
        return self::decodeJsonObject($row[$key] ?? null);
    }

    /**
     * Filter a (possibly mixed-key) array down to its string-keyed entries.
     * Use this when narrowing values from PHP sources that produce
     * `array<int|string, mixed>` (parse_str, json_decode arrays, FastRoute
     * vars, session payloads) into the `array<string, mixed>` shape
     * downstream code expects.
     *
     * @return array<string, mixed>
     */
    public static function stringKeyed(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $k => $v) {
            if (is_string($k)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /**
     * Narrow a raw mixed JSON-ish value to a string-keyed array.
     * Accepts: native arrays (rekeys numeric keys to strings), JSON strings
     *          (decodes), and anything else returns [].
     *
     * Use this when you have a value off the boundary (PDO JSONB column,
     * request body field, etc.) and want a typed map.
     *
     * @return array<string, mixed>
     */
    public static function decodeJsonObject(mixed $value): array
    {
        if ($value === null || $value === '') {
            return [];
        }
        if (is_string($value)) {
            $value = json_decode($value, true);
        }
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $k => $v) {
            $out[(string)$k] = $v;
        }
        return $out;
    }

    /**
     * @param array<array-key, mixed> $row
     * @throws RuntimeException when the column is missing or not scalar
     */
    public static function requireStr(array $row, string $key): string
    {
        $v = $row[$key] ?? null;
        if (!is_scalar($v)) {
            throw new RuntimeException("Row column {$key} expected scalar, got " . get_debug_type($v));
        }
        return (string)$v;
    }

    /**
     * @param array<array-key, mixed> $row
     * @throws RuntimeException when the column is missing or not scalar
     */
    public static function requireInt(array $row, string $key): int
    {
        $v = $row[$key] ?? null;
        if (!is_scalar($v)) {
            throw new RuntimeException("Row column {$key} expected scalar, got " . get_debug_type($v));
        }
        return (int)$v;
    }
}
