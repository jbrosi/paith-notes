<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;

final class MeController
{
    public function me(Request $request, Context $context): Response
    {
        $user = $context->user();

        return JsonResponse::ok([
            'user' => [
                'id' => $user['id'] ?? '',
                'first_name' => $user['first_name'] ?? '',
                'last_name' => $user['last_name'] ?? '',
            ],
        ]);
    }
}
