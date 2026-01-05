<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

final class TextResponse implements Response
{
    private int $statusCode;

    private array $headers;

    private string $body;

    public function __construct(string $body, int $statusCode = 200, array $headers = [])
    {
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->headers['Content-Type'] = $this->headers['Content-Type'] ?? 'text/plain; charset=utf-8';
        $this->body = $body;
    }

    public function statusCode(): int
    {
        return $this->statusCode;
    }

    public function headers(): array
    {
        return $this->headers;
    }

    public function body(): string
    {
        return $this->body;
    }
}
