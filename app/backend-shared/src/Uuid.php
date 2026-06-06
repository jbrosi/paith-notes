<?php

declare(strict_types=1);

namespace Paith\Notes\Shared;

/**
 * UUID v4 generation + validation.
 *
 * Single canonical implementation — controllers and services should not
 * roll their own isUuid / generateUuid private helpers.
 */
final class Uuid
{
    /** Strict v4 pattern with version bit + variant bits (1-5 / 8-b). */
    public const REGEX = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';

    public static function isValid(string $value): bool
    {
        return preg_match(self::REGEX, $value) === 1;
    }

    /**
     * Generate a v4 UUID. Cryptographically random via random_bytes().
     */
    public static function v4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
