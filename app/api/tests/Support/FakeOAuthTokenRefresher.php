<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Tests\Support;

use Paith\Notes\Api\Http\Auth\OAuthTokenRefresher;
use RuntimeException;

/**
 * Fake OAuth token refresher for tests.
 *
 * Configure via willReturn() / willThrow() before invoking the middleware.
 */
final class FakeOAuthTokenRefresher implements OAuthTokenRefresher
{
    /** @var array<string,mixed>|null */
    private ?array $response = null;

    private ?\Throwable $error = null;

    private int $callCount = 0;

    /** @param array<string, mixed> $payload Must contain at least "access_token". */
    public function willReturn(array $payload): void
    {
        $this->response = $payload;
        $this->error = null;
    }

    public function willThrow(\Throwable $error): void
    {
        $this->error = $error;
        $this->response = null;
    }

    public function callCount(): int
    {
        return $this->callCount;
    }

    public function refreshToken(string $refreshToken): array
    {
        $this->callCount++;

        if ($this->error !== null) {
            throw $this->error;
        }

        if ($this->response !== null) {
            return $this->response;
        }

        throw new RuntimeException('FakeOAuthTokenRefresher: no response configured');
    }
}
