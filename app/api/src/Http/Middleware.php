<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

interface Middleware
{
    /** @param callable(Request, Context): Response $next */
    public function handle(Request $request, Context $context, callable $next): Response;
}
