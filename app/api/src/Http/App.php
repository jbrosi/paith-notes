<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use Paith\Notes\Shared\Db\Row;
use PDO;

final class App
{
    /**
     * Required secrets — boot hard-fails if any are missing, warns if any
     * look like the placeholder strings shipped in .env.example. Keep this
     * list in sync with both .env.example files.
     */
    private const REQUIRED_SECRETS = ['SESSION_SECRET', 'FILES_SIGNING_KEY'];

    public static function run(): void
    {
        self::checkSecretsOrDie();

        $handler = static function (): void {
            $request = Request::fromGlobals();
            $response = self::kernel()->handle($request, self::context());
            self::emit($response);
        };

        while (frankenphp_handle_request($handler)) {
        }
    }

    /**
     * Inspect a map of secret-name → value and return any problems found.
     * Pure — no env access, no side effects, no exit() — so it's straightforward
     * to test. The runtime wrapper below is what reads env and acts on the
     * issues.
     *
     * @param array<string, string> $secrets
     * @return list<array{key: string, severity: 'fatal'|'warning', reason: string}>
     */
    public static function secretIssues(array $secrets): array
    {
        $issues = [];
        foreach ($secrets as $key => $value) {
            if ($value === '') {
                $issues[] = ['key' => $key, 'severity' => 'fatal', 'reason' => 'missing'];
                continue;
            }
            if (self::looksLikePlaceholder($value)) {
                $issues[] = ['key' => $key, 'severity' => 'warning', 'reason' => 'placeholder'];
                continue;
            }
            if (strlen($value) < 32) {
                $issues[] = ['key' => $key, 'severity' => 'warning', 'reason' => 'short'];
            }
        }
        return $issues;
    }

    private static function checkSecretsOrDie(): void
    {
        $secrets = [];
        foreach (self::REQUIRED_SECRETS as $key) {
            $secrets[$key] = (string)getenv($key);
        }

        $issues = self::secretIssues($secrets);

        $missing = [];
        foreach ($issues as $issue) {
            if ($issue['severity'] === 'fatal') {
                $missing[] = $issue['key'];
                continue;
            }
            $reason = $issue['reason'] === 'placeholder'
                ? 'matches a placeholder string from .env.example'
                : 'is shorter than 32 characters';
            fwrite(STDERR, "[paith] WARNING: {$issue['key']} {$reason}. Replace with: openssl rand -hex 32\n");
        }

        if ($missing === []) {
            return;
        }

        // Banner so the message survives the FrankenPHP worker-restart spam.
        // Without the bracketing lines + sleep, this fatal gets buried under
        // 70+ lines of "many consecutive worker failures" JSON within seconds.
        $line = str_repeat('═', 72);
        $lines = [
            '',
            $line,
            '  paith — BOOT REFUSED: required secret(s) missing',
            '',
        ];
        foreach ($missing as $key) {
            $lines[] = "    - {$key}";
        }
        $lines[] = '';
        $lines[] = '  Generate each with:  openssl rand -hex 32';
        $lines[] = '  Then set them in your .env (or in docker-compose env).';
        $lines[] = $line;
        $lines[] = '';

        fwrite(STDERR, implode("\n", $lines));

        // Slow the worker-restart loop so the banner above stays readable.
        // FrankenPHP will keep respawning anyway; this just buys the operator
        // time to actually see the message before it scrolls off-screen.
        sleep(3);
        exit(1);
    }

    private static function looksLikePlaceholder(string $value): bool
    {
        foreach (['replace-me', 'change-me', 'paste-here'] as $marker) {
            if (stripos($value, $marker) !== false) {
                return true;
            }
        }
        return false;
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
