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

    private static function normalizeGroupPath(string $group): string
    {
        $trimmed = trim($group);
        if ($trimmed === '') {
            return '';
        }

        $trimmed = '/' . trim($trimmed, '/');
        return $trimmed === '/' ? '' : $trimmed;
    }

    public function handle(Request $request, Context $context, callable $next): Response
    {
        $groups = [];
        if ((string)getenv('KEYCLOAK_ENABLED') === '1') {
            $user = $context->user();
            $rawGroups = $user['groups'] ?? [];
            if (is_array($rawGroups)) {
                foreach ($rawGroups as $g) {
                    if (is_string($g) && $g !== '') {
                        $groups[] = $g;
                    }
                }
            }
        } else {
            $raw = trim($request->header('X-Nook-Groups'));
            if ($raw !== '') {
                $groups = preg_split('/[\s,]+/', $raw) ?: [];
            }
        }

        $required = self::normalizeGroupPath($this->group);
        $found = false;
        foreach ($groups as $g) {
            if (!is_string($g) || $g === '') {
                continue;
            }

            $g = self::normalizeGroupPath($g);
            if ($g === '' || $required === '') {
                continue;
            }

            if ($g === $required || str_starts_with($g, $required . '/')) {
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
