<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use Paith\Notes\Shared\Db\Row;
use PDO;

final class App
{
    public static function run(): void
    {
        $handler = static function (): void {
            $request = Request::fromGlobals();
            $response = self::kernel()->handle($request, self::context());
            self::emit($response);
        };

        while (frankenphp_handle_request($handler)) {
        }
    }

    /**
     * Test-only entry point: build a Request and run it through the kernel
     * synchronously. Returns the response as a plain array.
     *
     * @param array<string, string> $headers
     * @return array{status: int, headers: array<string, string>, body: string}
     */
    public static function handle(string $method, string $path, array $headers = [], string $body = ''): array
    {
        $parsedPath = parse_url($path, PHP_URL_PATH);
        $requestPath = is_string($parsedPath) && $parsedPath !== '' ? $parsedPath : $path;

        $parsed = [];
        $qs = parse_url($path, PHP_URL_QUERY);
        if (is_string($qs) && $qs !== '') {
            parse_str($qs, $parsed);
        }

        $request = new Request($method, $requestPath, $headers, Row::stringKeyed($parsed), $body);
        $response = self::kernel()->handle($request, self::context());

        return [
            'status' => $response->statusCode(),
            'headers' => $response->headers(),
            'body' => $response->body(),
        ];
    }

    private static function kernel(): Kernel
    {
        static $kernel = null;
        if ($kernel instanceof Kernel) {
            return $kernel;
        }

        /** @var array{0: \FastRoute\Dispatcher, 1: array<string, list<Middleware>>} $built */
        $built = Routes::build();
        [$dispatcher, $prefixMiddlewares] = $built;
        $kernel = new Kernel($dispatcher, $prefixMiddlewares);
        return $kernel;
    }

    private static function context(): Context
    {
        return new Context(static function (): PDO {
            return Db::pdoFromEnv();
        });
    }

    private static function emit(Response $response): void
    {
        http_response_code($response->statusCode());

        foreach ($response->headers() as $k => $v) {
            header($k . ': ' . $v);
        }

        if ($response instanceof FileResponse) {
            $fp = fopen($response->filePath(), 'rb');
            if ($fp !== false) {
                while (!feof($fp)) {
                    echo fread($fp, 8192);
                    flush();
                }
                fclose($fp);
            }
            if ($response->deleteAfter()) {
                @unlink($response->filePath());
            }
        } else {
            echo $response->body();
        }
    }
}
