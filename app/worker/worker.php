<?php
declare(strict_types=1);

$autoload = '/app/worker/vendor/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "Worker dependencies are not installed. Run: composer install --working-dir=app/worker\n");
    exit(1);
}

require_once $autoload;

Paith\Notes\Worker\Runner::run();
