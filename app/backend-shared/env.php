<?php
declare(strict_types=1);

function env_get(string $key, string $default = ''): string
{
    $value = getenv($key);
    if ($value === false) {
        return $default;
    }
    return $value;
}

function env_require(string $key): string
{
    $value = env_get($key);
    if ($value === '') {
        throw new RuntimeException(sprintf('%s is not set', $key));
    }
    return $value;
}
