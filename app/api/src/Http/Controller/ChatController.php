<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\TextResponse;

final class ChatController
{
    /**
     * Forward-auth endpoint called by the Node.js chat service.
     * The Node.js service forwards the browser's Cookie header here;
     * if the session is valid, we respond 200 so it can proceed.
     */
    public function auth(Request $request, Context $context): Response
    {
        $user   = $context->user(); // RequireUser middleware guarantees this is set
        $userId = (string) ($user['id'] ?? '');

        return new TextResponse('', 200, ['X-Chat-User-Id' => $userId]);
    }
}
