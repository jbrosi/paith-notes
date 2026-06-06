<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use RuntimeException;

/**
 * Type-safe accessors for PDO row arrays (PDO::FETCH_ASSOC results).
 *
 * Each method narrows a mixed cell to a concrete type. Required fields
 * throw RuntimeException when missing or malformed — that signals a
 * schema/migration bug, not user input, so 500 is appropriate.
 *
 * Use these inside Row DTO `fromRow()` factories so controllers never
 * touch a raw `array<string, mixed>` cell.
 */
final class RowReader
{
    /**
     * @param array<array-key, mixed> $row
     */
    public static function requireString(array $row, string $col): string
    {
        $value = $row[$col] ?? null;
        if (!is_scalar($value)) {
            throw new RuntimeException("Column {$col} expected scalar, got " . get_debug_type($value));
        }
        return (string) $value;
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function optionalString(array $row, string $col): ?string
    {
        $value = $row[$col] ?? null;
        if ($value === null) {
            return null;
        }
        if (!is_scalar($value)) {
            return null;
        }
        return (string) $value;
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function requireInt(array $row, string $col): int
    {
        $value = $row[$col] ?? null;
        if (!is_scalar($value)) {
            throw new RuntimeException("Column {$col} expected scalar, got " . get_debug_type($value));
        }
        return (int) $value;
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function optionalInt(array $row, string $col): ?int
    {
        $value = $row[$col] ?? null;
        if ($value === null) {
            return null;
        }
        if (!is_scalar($value)) {
            return null;
        }
        return (int) $value;
    }

    /**
     * Postgres returns booleans as 't'/'f' through PDO by default and as
     * native bool with PDO::ATTR_STRINGIFY_FETCHES off. Handle both.
     *
     * @param array<array-key, mixed> $row
     */
    public static function optionalBool(array $row, string $col): bool
    {
        $value = $row[$col] ?? null;
        if (is_bool($value)) {
            return $value;
        }
        if ($value === 't' || $value === 'true' || $value === 1 || $value === '1') {
            return true;
        }
        return false;
    }

    /**
     * Decode a JSONB column. Returns empty array when null, missing, or
     * non-object. JSON arrays decode to lists (numeric keys).
     *
     * @param array<array-key, mixed> $row
     * @return array<string, mixed>
     */
    public static function jsonObject(array $row, string $col): array
    {
        $value = $row[$col] ?? null;
        if ($value === null || $value === '') {
            return [];
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $out[(string) $k] = $v;
            }
            return $out;
        }
        if (!is_string($value)) {
            return [];
        }
        $decoded = json_decode($value, true);
        if (!is_array($decoded)) {
            return [];
        }
        $out = [];
        foreach ($decoded as $k => $v) {
            $out[(string) $k] = $v;
        }
        return $out;
    }
}
