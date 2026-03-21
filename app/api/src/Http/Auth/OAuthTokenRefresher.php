<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

interface OAuthTokenRefresher
{
    /**
     * Exchange a refresh token for a new token set.
     *
     * @return array<string, mixed> Token payload that must contain at least "access_token".
     * @throws \RuntimeException on any failure (network error, invalid grant, etc.).
     */
    public function refreshToken(string $refreshToken): array;
}
