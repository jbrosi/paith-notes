<?php
declare(strict_types=1);

$autoloaders = [
    __DIR__ . '/api/vendor/autoload.php',
    __DIR__ . '/worker/vendor/autoload.php',
];

foreach ($autoloaders as $autoload) {
    if (is_file($autoload)) {
        require_once $autoload;
    }
}
