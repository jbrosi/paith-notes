<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Rows\SearchHeadingRow;
use Paith\Notes\Shared\Db\Rows\SearchNoteRow;
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
        $userId = $user->id;

        $q = strtolower(trim($request->queryParam('q')));
        if ($q === '') {
            return JsonResponse::ok(['notes' => []]);
        }

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));

        $searchMode = strtolower(trim($request->queryParam('search_mode')));
        if (!in_array($searchMode, ['and', 'or'], true)) {
            $searchMode = 'and';
        }

        $search = SearchQueryParser::buildSearchClause($q, $searchMode, 'lower(n.title)', 'lower(n.content)', '');
        if ($search['where'] === '') {
            return JsonResponse::ok(['notes' => []]);
        }

        $searchRank = '(' . $search['rank'] . ' + ln(1 + least(coalesce(ns.view_count, 0), 1000)) * 0.5)';

        // Exclude nooks where the owner has set ai_mode='disabled' — cross-
        // nook search must respect the per-nook AI ban regardless of which
        // direction the search comes from. Single-nook fetch flows already
        // get a clean error at the MCP layer; this guard handles the
        // multi-nook surface where MCP can't filter per-result.
        // Note: the search_in_note tool will still work on individual
        // notes inside disabled nooks if the AI somehow gets an ID — that's
        // blocked at the MCP layer, not here.
        $stmt = $pdo->prepare(
            "select n.id, n.title, n.nook_id, nk.name as nook_name, n.type_id, n.version, n.created_at,
                    coalesce(ns.outgoing_mentions, 0) as outgoing_mentions_count,
                    coalesce(ns.incoming_mentions, 0) as incoming_mentions_count,
                    coalesce(ns.outgoing_links, 0) as outgoing_links_count,
                    coalesce(ns.incoming_links, 0) as incoming_links_count,
                    char_length(coalesce(n.content, '')) as content_chars,
                    {$searchRank} as search_rank
             from global.notes n
             join global.nooks nk on nk.id = n.nook_id
             join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id
             left join global.note_stats ns on ns.note_id = n.id
             where {$search['where']}
               and nk.ai_mode <> 'disabled'
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
            if (!is_array($r)) {
                continue;
            }
            $notes[] = SearchNoteRow::fromRow($r)->toArray();
        }

        // Heading matches across accessible nooks
        $headingMatches = [];
        $headingTerms = SearchQueryParser::splitTerms($q);
        if ($headingTerms !== []) {
            $hClauses = [];
            $hBindings = [];
            foreach ($headingTerms as $i => $term) {
                $hp = ':hq' . $i;
                $hClauses[] = "lower(h.text) like {$hp}";
                $hBindings[$hp] = '%' . $term . '%';
            }
            $hGlue = $searchMode === 'or' ? ' or ' : ' and ';
            $hWhere = implode($hGlue, $hClauses);

            $hStmt = $pdo->prepare(
                "select h.note_id, h.nook_id, h.level, h.text, h.position,
                        n.title as note_title, nk.name as nook_name
                 from global.note_headings h
                 join global.notes n on n.id = h.note_id
                 join global.nooks nk on nk.id = h.nook_id
                 join global.nook_members nm on nm.nook_id = h.nook_id and nm.user_id = :h_user_id
                 where {$hWhere}
                 order by similarity(lower(h.text), :hq_full) desc
                 limit 10"
            );
            $hStmt->bindValue(':h_user_id', $userId);
            $hStmt->bindValue(':hq_full', $q);
            foreach ($hBindings as $param => $val) {
                $hStmt->bindValue($param, $val);
            }
            $hStmt->execute();
            $hRows = $hStmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($hRows as $hr) {
                if (!is_array($hr)) {
                    continue;
                }
                $headingMatches[] = SearchHeadingRow::fromRow($hr)->toArray();
            }
        }

        return JsonResponse::ok(['notes' => $notes, 'heading_matches' => $headingMatches]);
    }
}
