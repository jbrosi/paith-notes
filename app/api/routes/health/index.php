<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    $r->addRoute('GET', '/health', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'health']);
    $r->addRoute('GET', '/healthz', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'health']);
    $r->addRoute('GET', '/health/db', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'db']);
};
