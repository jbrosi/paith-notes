<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

final class Request
{
    private string $method;

    private string $path;

    private array $headers;

    private array $query;

    private string $body;

    private array $routeParams;

    public function __construct(string $method, string $path, array $headers = [], array $query = [], string $body = '', array $routeParams = [])
    {
        $this->method = strtoupper($method);
        $this->path = $path;
        $this->headers = $this->normalizeHeaders($headers);
        $this->query = $query;
        $this->body = $body;
        $this->routeParams = $routeParams;
    }

    public static function fromGlobals(): self
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (!is_string($method)) {
            $method = 'GET';
        }

        $requestUri = $_SERVER['REQUEST_URI'] ?? '/';
        if (!is_string($requestUri)) {
            $requestUri = '/';
        }

        $parsedPath = parse_url($requestUri, PHP_URL_PATH);
        $path = is_string($parsedPath) ? $parsedPath : '/';

        $query = [];
        $qs = parse_url($requestUri, PHP_URL_QUERY);
        if (is_string($qs) && $qs !== '') {
            parse_str($qs, $query);
        }

        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (!is_string($k) || !is_scalar($v)) {
                continue;
            }
            if (str_starts_with($k, 'HTTP_')) {
                $name = str_replace('_', '-', substr($k, 5));
                $headers[$name] = (string)$v;
                continue;
            }
            if ($k === 'CONTENT_TYPE') {
                $headers['Content-Type'] = (string)$v;
            }
            if ($k === 'CONTENT_LENGTH') {
                $headers['Content-Length'] = (string)$v;
            }
        }

        $body = '';
        $raw = file_get_contents('php://input');
        if (is_string($raw)) {
            $body = $raw;
        }

        return new self($method, $path, $headers, $query, $body);
    }

    public function method(): string
    {
        return $this->method;
    }

    public function path(): string
    {
        return $this->path;
    }

    public function headers(): array
    {
        return $this->headers;
    }

    public function header(string $name): string
    {
        $key = strtolower($name);
        $value = $this->headers[$key] ?? '';
        return is_string($value) ? $value : '';
    }

    public function query(): array
    {
        return $this->query;
    }

    public function queryParam(string $name): string
    {
        $v = $this->query[$name] ?? '';
        return is_scalar($v) ? (string)$v : '';
    }

    public function body(): string
    {
        return $this->body;
    }

    /**
     * Decode the request body as a JSON object. Returns empty array on empty
     * body, invalid JSON, non-object JSON, or any other failure mode — so
     * callers can rely on the shape and validate field-by-field.
     *
     * @return array<string, mixed>
     */
    public function jsonBody(): array
    {
        if ($this->body === '') {
            return [];
        }

        $data = json_decode($this->body, true);
        if (!is_array($data)) {
            return [];
        }
        $out = [];
        foreach ($data as $k => $v) {
            if (is_string($k)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    public function routeParams(): array
    {
        return $this->routeParams;
    }

    public function routeParam(string $name): string
    {
        $v = $this->routeParams[$name] ?? '';
        return is_scalar($v) ? (string)$v : '';
    }

    /**
     * Read a route param expected to be a UUID. Throws HttpError 400 when
     * missing or malformed — saves the repeated `trim + isUuid + throw`
     * block at the top of every controller method.
     */
    public function requireUuidRouteParam(string $name): string
    {
        $v = trim($this->routeParam($name));
        if ($v === '') {
            throw new HttpError("{$name} is required", 400);
        }
        if (!\Paith\Notes\Shared\Uuid::isValid($v)) {
            throw new HttpError("{$name} must be a UUID", 400);
        }
        return $v;
    }

    public function withRouteParams(array $params): self
    {
        return new self($this->method, $this->path, $this->headers, $this->query, $this->body, $params);
    }

    private function normalizeHeaders(array $headers): array
    {
        $out = [];
        foreach ($headers as $k => $v) {
            if (!is_string($k) || !is_scalar($v)) {
                continue;
            }
            $out[strtolower($k)] = (string)$v;
        }
        return $out;
    }
}
