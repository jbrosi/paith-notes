<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    $prefixMiddlewares['/api/module_1/'] = [
        new \Paith\Notes\Api\Http\Middleware\RequireGroup('paith_module_1_users'),
    ];

    $r->addRoute('GET', '/api/module_1/ping', [\Paith\Notes\Api\Http\Controller\Module1Controller::class, 'ping']);
};
