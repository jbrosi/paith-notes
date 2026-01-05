<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Middleware;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Middleware;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;

final class RequireGroup implements Middleware
{
    private string $group;

    public function __construct(string $group)
    {
        $this->group = $group;
    }

    public function handle(Request $request, Context $context, callable $next): Response
    {
        $raw = trim($request->header('X-Nook-Groups'));
        if ($raw === '') {
            throw new HttpError('missing group membership', 403);
        }

        $groups = preg_split('/[\s,]+/', $raw) ?: [];
        $found = false;
        foreach ($groups as $g) {
            if ($g === $this->group) {
                $found = true;
                break;
            }
        }

        if (!$found) {
            throw new HttpError('missing group membership', 403);
        }

        return $next($request, $context);
    }
}
