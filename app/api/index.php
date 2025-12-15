<?php
declare(strict_types=1);

// Prevent the worker from terminating when a client disconnects mid-request
ignore_user_abort(true);

$autoload = '/app/api/vendor/autoload.php';
if (!is_file($autoload)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "API dependencies are not installed. Run: composer install --working-dir=app/api\n";
    exit(1);
}

require_once $autoload;

// Main worker loop: FrankenPHP will repeatedly call your handler for each request
Paith\Notes\Api\Http\App::run();
