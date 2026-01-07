<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Routes;

use Paith\Notes\Api\Http\Controller\MeController;
use Paith\Notes\Api\Http\Controller\NooksController;
use Paith\Notes\Api\Http\Middleware\RequireGroup;
use Paith\Notes\Api\Http\Middleware\RequireUser;
use Paith\Notes\Api\Http\RouteScope;

final class ApiRoutes
{
    public static function register(RouteScope $r): void
    {
        $r->use('/', new RequireUser());
        $r->use('/', new RequireGroup('paith/notes/'));

        $r->get('/me', [MeController::class, 'me']);
        $r->get('/nooks', [NooksController::class, 'list']);
        $r->post('/nooks', [NooksController::class, 'create']);

        $r->group('/module_1', [Module1Routes::class, 'register']);
    }
}
