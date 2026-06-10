<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

final class JsonResponse implements Response
{
    private int $statusCode;

    /** @var array<string, string> */
    private array $headers;

    private string $body;

    /**
     * @param array<string, mixed> $payload
     * @param array<string, string> $headers
     */
    public function __construct(int $statusCode, array $payload, array $headers = [])
    {
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->headers['Content-Type'] = 'application/json; charset=utf-8';
        $this->body = (string)json_encode($payload, JSON_UNESCAPED_SLASHES);
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function ok(array $payload, int $statusCode = 200): self
    {
        if (!array_key_exists('status', $payload)) {
            $payload = ['status' => 'ok'] + $payload;
        }
        return new self($statusCode, $payload);
    }

    /**
     * @param array<string, mixed> $extra
     */
    public static function error(string $message, int $statusCode = 500, array $extra = []): self
    {
        $payload = ['status' => 'error', 'error' => $message] + $extra;
        return new self($statusCode, $payload);
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
        return $this->body;
    }

    public function withHeader(string $name, string $value): self
    {
        $this->headers[$name] = $value;
        return $this;
    }
}
