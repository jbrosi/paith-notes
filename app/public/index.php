<?php
declare(strict_types=1);

$autoload = '/app/api/vendor/autoload.php';
if (is_file($autoload)) {
    require_once $autoload;
}

// Prevent the worker from terminating when a client disconnects mid-request
ignore_user_abort(true);
static $pid;
$pid ??= getmypid();

echo json_encode([
    'pid' => $pid,
]);

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

        $databaseUrl = getenv('DATABASE_URL') ?: '';
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

// Main worker loop: FrankenPHP will repeatedly call your handler for each request
while (frankenphp_handle_request($handler)) {
    // You can do per-request cleanup here if you keep state (you shouldn't, yet 😈)
}
