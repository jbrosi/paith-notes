<?php
declare(strict_types=1);

$entry = '/app/worker/worker.php';
if (!is_file($entry)) {
    fwrite(STDERR, "Worker entrypoint missing: /app/worker/worker.php\n");
    exit(1);
}

require $entry;
