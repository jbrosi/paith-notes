<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Routes;

use Paith\Notes\Api\Http\Controller\Module1Controller;
use Paith\Notes\Api\Http\Middleware\RequireGroup;
use Paith\Notes\Api\Http\RouteScope;

final class Module1Routes
{
    public static function register(RouteScope $r): void
    {
        $r->use('/', new RequireGroup('paith_module_1_users'));
        $r->get('/ping', [Module1Controller::class, 'ping']);
    }
}
