<?php
declare(strict_types=1);

namespace Paith\Notes\Shared;

use RuntimeException;

final class Env
{
    public static function get(string $key, string $default = ''): string
    {
        $value = getenv($key);
        if ($value === false) {
            return $default;
        }
        return $value;
    }

    public static function require(string $key): string
    {
        $value = self::get($key);
        if ($value === '') {
            throw new RuntimeException(sprintf('%s is not set', $key));
        }
        return $value;
    }
}
