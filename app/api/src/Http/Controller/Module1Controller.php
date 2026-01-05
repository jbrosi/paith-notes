<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;

final class Module1Controller
{
    public function ping(Request $request, Context $context): Response
    {
        $user = $context->user();

        return JsonResponse::ok([
            'module' => 'module_1',
            'pong' => true,
            'user_id' => $user['id'] ?? '',
        ]);
    }
}
