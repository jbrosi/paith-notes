<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use FastRoute\Dispatcher;
use FastRoute\RouteCollector;
use Paith\Notes\Api\Http\Controller\HealthController;
use Paith\Notes\Api\Http\Routes\ApiRoutes;

use function FastRoute\simpleDispatcher;

final class Routes
{
    /** @return array{0: Dispatcher, 1: array<string, list<Middleware>>} */
    public static function build(): array
    {
        /** @var array<string, list<Middleware>> $prefixMiddlewares */
        $prefixMiddlewares = [];

        $dispatcher = simpleDispatcher(static function (RouteCollector $r) use (&$prefixMiddlewares): void {
            $addPrefixMiddleware = static function (string $absolutePrefix, Middleware $middleware) use (&$prefixMiddlewares): void {
                $prefixMiddlewares[$absolutePrefix] = $prefixMiddlewares[$absolutePrefix] ?? [];
                $prefixMiddlewares[$absolutePrefix][] = $middleware;
            };

            $scope = new RouteScope($r, $addPrefixMiddleware);

            self::registerRootRoutes($scope);
        });

        return [$dispatcher, $prefixMiddlewares];
    }

    public static function registerRootRoutes(RouteScope $r): void
    {
        $r->get('/health', [HealthController::class, 'health']);
        $r->get('/healthz', [HealthController::class, 'health']);
        $r->get('/health/db', [HealthController::class, 'db']);

        $r->group('/api', [ApiRoutes::class, 'register']);
    }
}
