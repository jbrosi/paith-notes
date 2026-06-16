<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Paith\Notes\Shared\Uuid;
use Paith\Notes\Api\Http\Auth\User;

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
        $params = [':user_id' => $user->id, ':user_id_sub' => $user->id];

        if ($before > 0) {
            $whereClause .= ' and am.id < :before';
            $params[':before'] = $before;
        }

        $stmt = $pdo->prepare(
            "select am.id, am.version, am.action, am.table_name, am.entity_id, am.nook_id, am.user_id, am.actor, am.created_at,
                    u.first_name, u.last_name, u.nickname,
                    n.title as note_title,
                    ad.data->>'source_note_id' as link_source_id,
                    ad.data->>'target_note_id' as link_target_id,
                    (select title from global.notes where id = (ad.data->>'source_note_id')::uuid) as link_source_title,
                    (select title from global.notes where id = (ad.data->>'target_note_id')::uuid) as link_target_title,
                    (select forward_label from global.link_predicates where id = (ad.data->>'predicate_id')::uuid) as link_forward_label
             from global.audit_meta am
             left join global.users u on u.id = am.user_id
             left join global.notes n on n.id = am.entity_id and am.table_name = 'notes'
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
        /** @var list<array<string, mixed>> $rows */
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

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));
        $beforeRaw = $request->queryParam('before');
        $before = $beforeRaw !== '' ? (int)$beforeRaw : 0;
        $filterUserId = trim($request->queryParam('user_id'));

        $whereClause = 'am.nook_id = :nook_id';
        $params = [':nook_id' => $nookId];

        if ($before > 0) {
            $whereClause .= ' and am.id < :before';
            $params[':before'] = $before;
        }

        if ($filterUserId !== '' && Uuid::isValid($filterUserId)) {
            $whereClause .= ' and am.user_id = :filter_user_id';
            $params[':filter_user_id'] = $filterUserId;
        }

        $stmt = $pdo->prepare(
            "select am.id, am.version, am.action, am.table_name, am.entity_id, am.nook_id, am.created_at,
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
             left join global.notes n on n.id = am.entity_id and am.table_name = 'notes'
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
        /** @var list<array<string, mixed>> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return JsonResponse::ok([
            'activity' => self::formatRows($rows),
        ]);
    }

    /**
     * @param list<array<string, mixed>> $rows
     * @return list<array<string, mixed>>
     */
    private static function formatRows(array $rows): array
    {
        $activity = [];
        foreach ($rows as $r) {
            $entry = [
                'id' => Row::int($r, 'id'),
                'version' => Row::int($r, 'version'),
                'action' => Row::str($r, 'action'),
                'actor' => Row::str($r, 'actor', 'user'),
                'table_name' => Row::str($r, 'table_name'),
                'table_id' => Row::str($r, 'entity_id'),
                'nook_id' => Row::str($r, 'nook_id'),
                'user_id' => Row::str($r, 'user_id'),
                'user_name' => trim(Row::str($r, 'nickname') !== '' ? Row::str($r, 'nickname') : (Row::str($r, 'first_name') . ' ' . Row::str($r, 'last_name'))),
                'created_at' => Row::str($r, 'created_at'),
            ];
            $noteTitle = Row::nullStr($r, 'note_title');
            if ($noteTitle !== null) {
                $entry['note_title'] = $noteTitle;
            }
            $linkSourceTitle = Row::nullStr($r, 'link_source_title');
            if ($linkSourceTitle !== null) {
                $entry['link_source_title'] = $linkSourceTitle;
            }
            $linkTargetTitle = Row::nullStr($r, 'link_target_title');
            if ($linkTargetTitle !== null) {
                $entry['link_target_title'] = $linkTargetTitle;
            }
            $linkSourceId = Row::nullStr($r, 'link_source_id');
            if ($linkSourceId !== null) {
                $entry['link_source_id'] = $linkSourceId;
            }
            $linkTargetId = Row::nullStr($r, 'link_target_id');
            if ($linkTargetId !== null) {
                $entry['link_target_id'] = $linkTargetId;
            }
            $linkForwardLabel = Row::nullStr($r, 'link_forward_label');
            if ($linkForwardLabel !== null) {
                $entry['link_forward_label'] = $linkForwardLabel;
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
        $params = [':user_id' => $user->id];

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
            $meta = json_decode(Row::str($r, 'meta', '{}'), true);
            $events[] = [
                'id' => Row::int($r, 'id'),
                'event' => Row::str($r, 'event'),
                'meta' => is_array($meta) ? $meta : [],
                'created_at' => Row::str($r, 'created_at'),
            ];
        }

        return JsonResponse::ok(['events' => $events]);
    }
}
