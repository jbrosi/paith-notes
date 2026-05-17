<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Search\SearchQueryParser;
use PDO;

final class SearchController
{
    /**
     * GET /api/search?q=...&limit=20
     * Cross-nook search across all nooks the user is a member of.
     */
    public function search(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';

        $q = strtolower(trim($request->queryParam('q')));
        if ($q === '') {
            return JsonResponse::ok(['notes' => []]);
        }

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));

        $search = SearchQueryParser::buildSearchClause($q, 'and', 'lower(n.title)', 'lower(n.content)', '');
        if ($search['where'] === '') {
            return JsonResponse::ok(['notes' => []]);
        }

        $searchRank = '(' . $search['rank'] . ' + ln(1 + least(coalesce(ns.view_count, 0), 1000)) * 0.5)';

        $stmt = $pdo->prepare(
            "select n.id, n.title, n.nook_id, nk.name as nook_name, n.type, n.type_id, n.created_at,
                    coalesce(ns.outgoing_mentions, 0) as outgoing_mentions_count,
                    coalesce(ns.incoming_mentions, 0) as incoming_mentions_count,
                    coalesce(ns.outgoing_links, 0) as outgoing_links_count,
                    coalesce(ns.incoming_links, 0) as incoming_links_count,
                    {$searchRank} as search_rank
             from global.notes n
             join global.nooks nk on nk.id = n.nook_id
             join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id
             left join global.note_stats ns on ns.note_id = n.id
             where {$search['where']}
             order by search_rank desc
             limit :limit"
        );

        $stmt->bindValue(':user_id', $userId);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        foreach ($search['bindings'] as $param => $val) {
            $stmt->bindValue($param, $val);
        }
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $notes[] = [
                'id' => (string)$r['id'],
                'title' => (string)$r['title'],
                'nook_id' => (string)$r['nook_id'],
                'nook_name' => (string)$r['nook_name'],
                'type' => (string)($r['type'] ?? 'anything'),
                'type_id' => (string)($r['type_id'] ?? ''),
                'outgoing_mentions_count' => (int)$r['outgoing_mentions_count'],
                'incoming_mentions_count' => (int)$r['incoming_mentions_count'],
                'outgoing_links_count' => (int)$r['outgoing_links_count'],
                'incoming_links_count' => (int)$r['incoming_links_count'],
                'created_at' => (string)$r['created_at'],
            ];
        }

        return JsonResponse::ok(['notes' => $notes]);
    }
}
