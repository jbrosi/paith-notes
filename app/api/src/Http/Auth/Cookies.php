<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

final class Cookies
{
    /** @return array<string, string> */
    public static function parseCookieHeader(string $cookieHeader): array
    {
        $out = [];
        $cookieHeader = trim($cookieHeader);
        if ($cookieHeader === '') {
            return $out;
        }

        $parts = explode(';', $cookieHeader);
        foreach ($parts as $p) {
            $p = trim($p);
            if ($p === '' || !str_contains($p, '=')) {
                continue;
            }
            [$k, $v] = explode('=', $p, 2);
            $k = trim($k);
            $v = trim($v);
            if ($k === '') {
                continue;
            }
            $out[$k] = urldecode($v);
        }
        return $out;
    }

    public static function buildSetCookie(string $name, string $value, int $maxAgeSeconds, bool $secure): string
    {
        $parts = [];
        $parts[] = $name . '=' . rawurlencode($value);
        $parts[] = 'Path=/';
        $parts[] = 'HttpOnly';
        $parts[] = 'SameSite=Lax';
        if ($secure) {
            $parts[] = 'Secure';
        }
        if ($maxAgeSeconds <= 0) {
            $parts[] = 'Max-Age=0';
        } else {
            $parts[] = 'Max-Age=' . (string)$maxAgeSeconds;
        }
        return implode('; ', $parts);
    }
}
