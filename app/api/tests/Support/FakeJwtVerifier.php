<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Tests\Support;

use Paith\Notes\Api\Http\Auth\JwtVerifier;
use RuntimeException;

/**
 * Fake JWT verifier for tests.
 *
 * Register expected tokens via willReturn() / willThrow() before invoking the middleware.
 * Any token not registered will throw to catch unexpected calls.
 */
final class FakeJwtVerifier implements JwtVerifier
{
    /** @var array<string, array<string,mixed>|\Throwable> */
    private array $responses = [];

    /** @param array<string, mixed> $claims */
    public function willReturn(string $token, array $claims): void
    {
        $this->responses[$token] = $claims;
    }

    public function willThrow(string $token, \Throwable $error): void
    {
        $this->responses[$token] = $error;
    }

    public function willExpire(string $token): void
    {
        $this->responses[$token] = new RuntimeException('JWT is expired');
    }

    public function verifyAndDecode(string $jwt): array
    {
        if (!array_key_exists($jwt, $this->responses)) {
            throw new RuntimeException('FakeJwtVerifier: unexpected token "' . $jwt . '"');
        }

        $response = $this->responses[$jwt];
        if ($response instanceof \Throwable) {
            throw $response;
        }

        return $response;
    }
}
