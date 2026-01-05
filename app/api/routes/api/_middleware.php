<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    $prefixMiddlewares['/api/'] = [
        new \Paith\Notes\Api\Http\Middleware\RequireUser(),
    ];
};
