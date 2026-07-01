<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Middleware;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Middleware;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;

/**
 * Owner-controlled, nook-wide AI policy enforcement.
 *
 * Reads `global.nooks.ai_mode` for the route's target nook and applies
 * the policy to every request whose actor is `ai` (X-Nook-Actor: ai):
 *
 *   approve_all  — no enforcement here; MCP gates per-call approval
 *   auto_reads   — no enforcement here; MCP relaxes its approval UX
 *   disabled     — hard 403, AI tool calls cannot touch this nook
 *
 * Defense in depth: MCP also short-circuits disabled-nook tool calls
 * before they leave the client, so the user never sees an approval
 * card for a banned nook. This middleware is the last-line guarantee
 * in case MCP is bypassed (direct API calls with X-Nook-Actor: ai).
 *
 * Human users (`X-Nook-Actor: user` or unset → defaulted to user)
 * always pass — `ai_mode` only constrains the AI actor.
 *
 * HTTP method is currently not used to discriminate read vs. write
 * because the only enforced mode (disabled) blocks both. A future
 * fourth mode like `read_only` would split on GET vs. POST/PUT/DELETE/
 * PATCH at the same hinge.
 */
final class EnforceNookAiPolicy implements Middleware
{
    public function handle(Request $request, Context $context, callable $next): Response
    {
        if ($context->actor() !== 'ai') {
            return $next($request, $context);
        }

        $nookId = trim($request->routeParam('nookId'));
        // Routes without a nookId (e.g. POST /nooks, GET /nooks) aren't
        // nook-scoped — the policy is per-nook, so nothing to enforce.
        if ($nookId === '') {
            return $next($request, $context);
        }

        // The 'ai-memory' alias resolves per-user inside controllers to
        // the caller's own AI memory nook; that nook is system-managed
        // and shouldn't ever be set to 'disabled'. Let the controller
        // resolve + handle.
        if ($nookId === 'ai-memory') {
            return $next($request, $context);
        }

        // Lightweight UUID shape check — if it's malformed, defer to the
        // downstream handler so the client gets a clean 404 from the real
        // route rather than a confusing 403 from us.
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $nookId) !== 1) {
            return $next($request, $context);
        }

        $stmt = $context->pdo()->prepare('select ai_mode from global.nooks where id = :id');
        $stmt->execute([':id' => $nookId]);
        $aiMode = $stmt->fetchColumn();

        // Unknown nook — let the downstream handler 404 naturally.
        if (!is_string($aiMode)) {
            return $next($request, $context);
        }

        if ($aiMode === 'disabled') {
            // Wording matters: the AI's tool result will surface this
            // message to the user verbatim, so it should be informative
            // ("the owner has turned this off") rather than scary.
            throw new HttpError('this nook has AI access disabled by its owner', 403);
        }

        return $next($request, $context);
    }
}
