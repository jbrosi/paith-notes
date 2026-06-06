<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;

/**
 * Type-safe accessors for decoded JSON request bodies.
 *
 * Every method that takes `$key` looks up `$data[$key]` and narrows the
 * mixed value to a concrete type, throwing HttpError 400 with a clear
 * message on validation failure.
 *
 * Use these in request DTO factories so the controller never sees
 * `array<string, mixed>` — only typed properties on a readonly object.
 */
final class JsonReader
{
    private const UUID_REGEX = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';

    /**
     * @param array<string, mixed> $data
     */
    public static function requireString(array $data, string $key): string
    {
        $value = $data[$key] ?? null;
        if (!is_string($value)) {
            throw new HttpError("{$key} is required", 400);
        }
        $trimmed = trim($value);
        if ($trimmed === '') {
            throw new HttpError("{$key} is required", 400);
        }
        return $trimmed;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function optionalString(array $data, string $key, string $default = ''): string
    {
        $value = $data[$key] ?? null;
        return is_string($value) ? $value : $default;
    }

    /**
     * Optional trimmed string — empty/missing returns default.
     *
     * @param array<string, mixed> $data
     */
    public static function optionalTrimmedString(array $data, string $key, string $default = ''): string
    {
        $value = $data[$key] ?? null;
        return is_string($value) ? trim($value) : $default;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function requireUuid(array $data, string $key): string
    {
        $value = self::requireString($data, $key);
        if (preg_match(self::UUID_REGEX, $value) !== 1) {
            throw new HttpError("{$key} must be a UUID", 400);
        }
        return $value;
    }

    /**
     * Returns null when the key is missing, not a string, or empty after trim.
     * Throws when present and non-empty but not a valid UUID.
     *
     * @param array<string, mixed> $data
     */
    public static function optionalUuid(array $data, string $key): ?string
    {
        $raw = $data[$key] ?? null;
        if (!is_string($raw)) {
            return null;
        }
        $value = trim($raw);
        if ($value === '') {
            return null;
        }
        if (preg_match(self::UUID_REGEX, $value) !== 1) {
            throw new HttpError("{$key} must be a UUID", 400);
        }
        return $value;
    }

    /**
     * Read an associative array (object-shaped). Returns empty array when
     * missing or when the value isn't a string-keyed array (numeric-keyed
     * lists are dropped).
     *
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function optionalAssoc(array $data, string $key): array
    {
        return \Paith\Notes\Shared\Db\Row::stringKeyed($data[$key] ?? null);
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function optionalBool(array $data, string $key, bool $default = false): bool
    {
        $value = $data[$key] ?? null;
        if (is_bool($value)) {
            return $value;
        }
        return $default;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function optionalInt(array $data, string $key, ?int $default = null): ?int
    {
        $value = $data[$key] ?? null;
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && $value !== '' && ctype_digit(ltrim($value, '-'))) {
            return (int) $value;
        }
        return $default;
    }
}
