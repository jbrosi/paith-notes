<?php
declare(strict_types=1);

$autoloaders = [
    '/app/api/vendor/autoload.php',
    '/app/worker/vendor/autoload.php',
];

foreach ($autoloaders as $autoload) {
    if (is_file($autoload)) {
        require_once $autoload;
    }
}
