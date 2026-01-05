<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    $r->addRoute('GET', '/api/nooks', [\Paith\Notes\Api\Http\Controller\NooksController::class, 'list']);
    $r->addRoute('POST', '/api/nooks', [\Paith\Notes\Api\Http\Controller\NooksController::class, 'create']);
};
