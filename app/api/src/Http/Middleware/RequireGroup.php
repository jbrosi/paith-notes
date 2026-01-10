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

    private static function debugEnabled(): bool
    {
        return (string)getenv('DEBUG_AUTH') === '1';
    }

    private static function debugLog(string $message, array $data = []): void
    {
        if (!self::debugEnabled()) {
            return;
        }

        $suffix = $data === [] ? '' : ' ' . (json_encode($data) ?: '');
        @file_put_contents('php://stderr', '[auth] ' . $message . $suffix . "\n");
    }

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
            $rawGroups = $user['groups'] ?? null;
            if (is_array($rawGroups)) {
                foreach ($rawGroups as $g) {
                    if (is_string($g) && $g !== '') {
                        $groups[] = $g;
                    }
                }
            }

            self::debugLog('RequireGroup (keycloak) extracted groups', [
                'required_raw' => $this->group,
                'required_normalized' => self::normalizeGroupPath($this->group),
                'raw_groups_type' => gettype($rawGroups),
                'groups_count' => count($groups),
                'groups_sample' => array_slice($groups, 0, 10),
            ]);
        } else {
            $raw = trim($request->header('X-Nook-Groups'));
            if ($raw !== '') {
                $groups = preg_split('/[\s,]+/', $raw) ?: [];
            }

            self::debugLog('RequireGroup (header) extracted groups', [
                'required_raw' => $this->group,
                'required_normalized' => self::normalizeGroupPath($this->group),
                'raw_header' => $raw,
                'groups_count' => count($groups),
                'groups_sample' => array_slice($groups, 0, 10),
            ]);
        }

        $required = self::normalizeGroupPath($this->group);
        $found = false;
        foreach ($groups as $g) {
            if ($g === '') {
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
            self::debugLog('RequireGroup missing membership', [
                'required_raw' => $this->group,
                'required_normalized' => $required,
                'groups_count' => count($groups),
                'groups_sample' => array_slice($groups, 0, 10),
            ]);
            throw new HttpError('missing group membership', 403);
        }

        return $next($request, $context);
    }
}
