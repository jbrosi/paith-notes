<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;

final class ActivityController
{
    /**
     * GET /api/me/activity
     * Activity feed for the current user across all their nooks.
     * Query params: ?limit=20&before=<audit_meta_id>
     */
    public function myActivity(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));
        $beforeRaw = $request->queryParam('before');
        $before = $beforeRaw !== '' ? (int)$beforeRaw : 0;

        $whereClause = 'am.user_id = :user_id and (am.nook_id is null or am.nook_id in (select nook_id from global.nook_members where user_id = :user_id_sub))';
        $params = [':user_id' => $user['id'], ':user_id_sub' => $user['id']];

        if ($before > 0) {
            $whereClause .= ' and am.id < :before';
            $params[':before'] = $before;
        }

        $stmt = $pdo->prepare(
            "select am.id, am.version, am.action, am.table_name, am.table_id, am.nook_id, am.user_id, am.actor, am.created_at,
                    u.first_name, u.last_name, u.nickname,
                    n.title as note_title,
                    ad.data->>'source_note_id' as link_source_id,
                    ad.data->>'target_note_id' as link_target_id,
                    (select title from global.notes where id = (ad.data->>'source_note_id')::uuid) as link_source_title,
                    (select title from global.notes where id = (ad.data->>'target_note_id')::uuid) as link_target_title,
                    (select forward_label from global.link_predicates where id = (ad.data->>'predicate_id')::uuid) as link_forward_label
             from global.audit_meta am
             left join global.users u on u.id = am.user_id
             left join global.notes n on n.id = am.table_id and am.table_name = 'notes'
             left join global.audit_data ad on ad.meta_id = am.id and am.table_name in ('note_links', 'note_cross_links')
             where {$whereClause}
             order by am.id desc
             limit :limit"
        );
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return JsonResponse::ok([
            'activity' => self::formatRows($rows),
        ]);
    }

    /**
     * GET /api/nooks/{nookId}/activity
     * Activity feed for a specific nook (all users).
     * Query params: ?limit=20&before=<audit_meta_id>&user_id=<uuid>
     */
    public function nookActivity(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));
        $beforeRaw = $request->queryParam('before');
        $before = $beforeRaw !== '' ? (int)$beforeRaw : 0;
        $filterUserId = trim((string)($request->queryParam('user_id') ?? ''));

        $whereClause = 'am.nook_id = :nook_id';
        $params = [':nook_id' => $nookId];

        if ($before > 0) {
            $whereClause .= ' and am.id < :before';
            $params[':before'] = $before;
        }

        if ($filterUserId !== '' && self::isUuid($filterUserId)) {
            $whereClause .= ' and am.user_id = :filter_user_id';
            $params[':filter_user_id'] = $filterUserId;
        }

        $stmt = $pdo->prepare(
            "select am.id, am.version, am.action, am.table_name, am.table_id, am.nook_id, am.created_at,
                    am.user_id, am.actor,
                    u.first_name, u.last_name, u.nickname,
                    n.title as note_title,
                    ad.data->>'source_note_id' as link_source_id,
                    ad.data->>'target_note_id' as link_target_id,
                    (select title from global.notes where id = (ad.data->>'source_note_id')::uuid) as link_source_title,
                    (select title from global.notes where id = (ad.data->>'target_note_id')::uuid) as link_target_title,
                    (select forward_label from global.link_predicates where id = (ad.data->>'predicate_id')::uuid) as link_forward_label
             from global.audit_meta am
             left join global.users u on u.id = am.user_id
             left join global.notes n on n.id = am.table_id and am.table_name = 'notes'
             left join global.audit_data ad on ad.meta_id = am.id and am.table_name in ('note_links', 'note_cross_links')
             where {$whereClause}
             order by am.id desc
             limit :limit"
        );
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return JsonResponse::ok([
            'activity' => self::formatRows($rows),
        ]);
    }

    /**
     * @param array<int, mixed> $rows
     * @return array<int, array<string, mixed>>
     */
    private static function formatRows(array $rows): array
    {
        $activity = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $entry = [
                'id' => (int)$r['id'],
                'version' => (int)$r['version'],
                'action' => (string)$r['action'],
                'actor' => (string)($r['actor'] ?? 'user'),
                'table_name' => (string)$r['table_name'],
                'table_id' => (string)$r['table_id'],
                'nook_id' => (string)($r['nook_id'] ?? ''),
                'user_id' => (string)($r['user_id'] ?? ''),
                'user_name' => trim(($r['nickname'] ?? '') !== '' ? (string)$r['nickname'] : ((string)($r['first_name'] ?? '') . ' ' . (string)($r['last_name'] ?? ''))),
                'created_at' => (string)$r['created_at'],
            ];
            if (isset($r['note_title']) && $r['note_title'] !== null) {
                $entry['note_title'] = (string)$r['note_title'];
            }
            if (isset($r['link_source_title']) && $r['link_source_title'] !== null) {
                $entry['link_source_title'] = (string)$r['link_source_title'];
            }
            if (isset($r['link_target_title']) && $r['link_target_title'] !== null) {
                $entry['link_target_title'] = (string)$r['link_target_title'];
            }
            if (isset($r['link_source_id']) && $r['link_source_id'] !== null) {
                $entry['link_source_id'] = (string)$r['link_source_id'];
            }
            if (isset($r['link_target_id']) && $r['link_target_id'] !== null) {
                $entry['link_target_id'] = (string)$r['link_target_id'];
            }
            if (isset($r['link_forward_label']) && $r['link_forward_label'] !== null) {
                $entry['link_forward_label'] = (string)$r['link_forward_label'];
            }
            $activity[] = $entry;
        }
        return $activity;
    }

    /**
     * GET /api/me/events
     * User session events (login, logout, etc.)
     * Query params: ?limit=20&before=<event_id>
     */
    public function myEvents(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));
        $beforeRaw = $request->queryParam('before');
        $before = $beforeRaw !== '' ? (int)$beforeRaw : 0;

        $whereClause = 'user_id = :user_id';
        $params = [':user_id' => $user['id']];

        if ($before > 0) {
            $whereClause .= ' and id < :before';
            $params[':before'] = $before;
        }

        $stmt = $pdo->prepare(
            "select id, event, meta, created_at
             from global.user_events
             where {$whereClause}
             order by id desc
             limit :limit"
        );
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $events = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $meta = json_decode((string)($r['meta'] ?? '{}'), true);
            $events[] = [
                'id' => (int)$r['id'],
                'event' => (string)$r['event'],
                'meta' => is_array($meta) ? $meta : [],
                'created_at' => (string)$r['created_at'],
            ];
        }

        return JsonResponse::ok(['events' => $events]);
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([':nook_id' => $nookId, ':user_id' => $user['id']]);
        if ($check->fetch() === false) {
            throw new HttpError('forbidden', 403);
        }
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
