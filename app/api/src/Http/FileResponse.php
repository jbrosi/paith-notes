<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

/**
 * Response that streams a file from disk, then deletes it.
 * Avoids loading the entire file into memory.
 */
final class FileResponse implements Response
{
    private int $statusCode;
    /** @var array<string, string> */
    private array $headers;
    private string $filePath;
    private bool $deleteAfter;

    /** @param array<string, string> $headers */
    public function __construct(string $filePath, int $statusCode = 200, array $headers = [], bool $deleteAfter = true)
    {
        $this->filePath = $filePath;
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->deleteAfter = $deleteAfter;
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

    /**
     * For compatibility with the Response interface.
     * Prefer using emit() directly for streaming.
     */
    public function body(): string
    {
        return '';
    }

    public function filePath(): string
    {
        return $this->filePath;
    }

    public function deleteAfter(): bool
    {
        return $this->deleteAfter;
    }
}
