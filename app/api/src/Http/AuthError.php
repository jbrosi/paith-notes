<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use RuntimeException;

final class AuthError extends RuntimeException
{
    public int $statusCode;

    public function __construct(string $message, int $statusCode)
    {
        parent::__construct($message);
        $this->statusCode = $statusCode;
    }
}
