<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Routes;

use FastRoute\RouteCollector;
use Paith\Notes\Api\Http\Controller\HealthController;

final class HealthRoutes
{
    public static function register(RouteCollector $r, array &$prefixMiddlewares): void
    {
        $r->addRoute('GET', '/health', [HealthController::class, 'health']);
        $r->addRoute('GET', '/healthz', [HealthController::class, 'health']);
        $r->addRoute('GET', '/health/db', [HealthController::class, 'db']);
    }
}
