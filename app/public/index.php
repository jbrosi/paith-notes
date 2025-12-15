<?php
declare(strict_types=1);

$entry = '/app/api/index.php';
if (!is_file($entry)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "API entrypoint missing: /app/api/index.php\n";
    exit(1);
}

require $entry;
