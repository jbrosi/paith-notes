<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

final class RedirectResponse implements Response
{
    private string $location;

    private int $statusCode;

    /** @var array<string, string> */
    private array $headers;

    /** @param array<string, string> $headers */
    public function __construct(string $location, int $statusCode = 302, array $headers = [])
    {
        $this->location = $location;
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->headers['Location'] = $this->location;
    }

    public function statusCode(): int
    {
        return $this->statusCode;
    }

    /** @return array<string, string> */
    public function headers(): array
    {
        return $this->headers;
    }

    public function body(): string
    {
        return '';
    }
}
