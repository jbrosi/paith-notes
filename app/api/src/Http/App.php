<?php
declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use Paith\Notes\Shared\Env;
use PDO;
use Throwable;

final class App
{
    public static function run(): void
    {
        $handler = static function (): void {
            static $counter = 0;

            $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
            if ($path === '/health' || $path === '/healthz') {
                header('Content-Type: application/json; charset=utf-8');
                echo json_encode([
                    'status'  => 'ok',
                    'service' => 'paith-notes',
                    'ts'      => gmdate('c'),
                    'counter' => $counter++
                ], JSON_UNESCAPED_SLASHES);
                return;
            }

            if ($path === '/health/db') {
                header('Content-Type: application/json; charset=utf-8');

                $databaseUrl = Env::get('DATABASE_URL');
                if ($databaseUrl === '') {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL is not set',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $availableDrivers = [];
                try {
                    $availableDrivers = PDO::getAvailableDrivers();
                } catch (Throwable) {
                    $availableDrivers = [];
                }

                if (!in_array('pgsql', $availableDrivers, true)) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'PDO pgsql driver is not installed (pdo_pgsql extension missing)',
                        'pdo_drivers' => $availableDrivers,
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $parts = parse_url($databaseUrl);
                if ($parts === false) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL is invalid',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $host = $parts['host'] ?? '';
                $port = (int)($parts['port'] ?? 5432);
                $user = $parts['user'] ?? '';
                $pass = $parts['pass'] ?? '';
                $dbName = ltrim((string)($parts['path'] ?? ''), '/');

                if ($host === '' || $user === '' || $dbName === '') {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => 'DATABASE_URL must include host, user, and database name',
                    ], JSON_UNESCAPED_SLASHES);
                    return;
                }

                $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $host, $port, $dbName);

                try {
                    $pdo = new PDO($dsn, $user, $pass, [
                        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                        PDO::ATTR_TIMEOUT => 2,
                    ]);
                    $serverVersion = $pdo->query('select version()')->fetchColumn();

                    echo json_encode([
                        'status' => 'ok',
                        'db' => [
                            'driver' => 'pgsql',
                            'host' => $host,
                            'port' => $port,
                            'name' => $dbName,
                            'server_version' => $serverVersion,
                        ],
                    ], JSON_UNESCAPED_SLASHES);
                } catch (Throwable $e) {
                    http_response_code(500);
                    echo json_encode([
                        'status' => 'error',
                        'error' => $e->getMessage(),
                        'type' => get_class($e),
                        'pdo_drivers' => $availableDrivers,
                    ], JSON_UNESCAPED_SLASHES);
                }

                return;
            }

            header('Content-Type: text/plain; charset=utf-8');
            echo "Paith Notes up. Try /health\n";
        };

        while (frankenphp_handle_request($handler)) {
        }
    }
}
