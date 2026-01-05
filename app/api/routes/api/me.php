<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    $r->addRoute('GET', '/api/me', [\Paith\Notes\Api\Http\Controller\MeController::class, 'me']);
};
