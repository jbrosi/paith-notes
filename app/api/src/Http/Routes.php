<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use FastRoute\Dispatcher;
use FastRoute\RouteCollector;

use function FastRoute\simpleDispatcher;

final class Routes
{
    public static function build(): array
    {
        $prefixMiddlewares = [];

        $dispatcher = simpleDispatcher(static function (RouteCollector $r) use (&$prefixMiddlewares): void {
            $prefixMiddlewares['/api/'] = [
                new \Paith\Notes\Api\Http\Middleware\RequireUser(),
            ];

            $prefixMiddlewares['/api/module_1/'] = [
                new \Paith\Notes\Api\Http\Middleware\RequireGroup('paith_module_1_users'),
            ];

            $r->addRoute('GET', '/health', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'health']);
            $r->addRoute('GET', '/healthz', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'health']);
            $r->addRoute('GET', '/health/db', [\Paith\Notes\Api\Http\Controller\HealthController::class, 'db']);

            $r->addRoute('GET', '/api/me', [\Paith\Notes\Api\Http\Controller\MeController::class, 'me']);
            $r->addRoute('GET', '/api/nooks', [\Paith\Notes\Api\Http\Controller\NooksController::class, 'list']);
            $r->addRoute('POST', '/api/nooks', [\Paith\Notes\Api\Http\Controller\NooksController::class, 'create']);

            $r->addRoute('GET', '/api/module_1/ping', [\Paith\Notes\Api\Http\Controller\Module1Controller::class, 'ping']);
        });

        return [$dispatcher, $prefixMiddlewares];
    }
}
