<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

interface JwtVerifier
{
    /**
     * Verify the JWT signature, expiry, issuer, and audience.
     *
     * @return array<string, mixed> The decoded claims.
     * @throws \RuntimeException with message "JWT is expired" when the token has expired,
     *                           or another message for any other verification failure.
     */
    public function verifyAndDecode(string $jwt): array;
}
