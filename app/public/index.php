<?php
declare(strict_types=1);

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

    header('Content-Type: text/plain; charset=utf-8');
    echo "Paith Notes up. Try /health\n";
};

// Main worker loop: FrankenPHP will repeatedly call your handler for each request
while (frankenphp_handle_request($handler)) {
    // You can do per-request cleanup here if you keep state (you shouldn't, yet 😈)
}
