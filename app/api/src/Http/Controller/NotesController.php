<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Service\AttributeValidator;
use Paith\Notes\Api\Http\Service\DiffService;
use Paith\Notes\Api\Http\Service\HeadingsService;
use Paith\Notes\Api\Http\Service\MentionsService;
use Paith\Notes\Api\Http\Auth\Cookies;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Auth\UrlSigner;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Dto\CreateNoteRequest;
use Paith\Notes\Api\Http\Dto\UpdateNoteRequest;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Shared\Db\Rows\CreatedNoteRow;
use Paith\Notes\Shared\Db\Rows\NoteDetailRow;
use Paith\Notes\Shared\Db\Rows\NoteFileMetadataRow;
use Paith\Notes\Shared\Db\Rows\NoteHeadingRow;
use Paith\Notes\Shared\Db\Rows\NoteListRow;
use Paith\Notes\Shared\Db\Rows\NoteSummaryRow;
use Paith\Notes\Shared\Search\SearchQueryParser;
use Paith\Notes\Shared\Uuid;
use PDO;
use Throwable;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\Auth\User;

final class NotesController
{
    private MentionsService $mentions;
    private HeadingsService $headings;

    public function __construct()
    {
        $this->mentions = new MentionsService();
        $this->headings = new HeadingsService();
    }

    /**
     * GET /nooks/{nookId}/notes/titles?q=...&limit=20
     *
     * Lean projection for the global notes-search dropdown. Returns
     * only id + title + type_id, no mention/link counts, no joins.
     * Replaces the heavier /note-types/all/notes prefetch the dropdown
     * used to do on every nook open — now it fetches on focus, with
     * a tighter cap (max 50, default 20) and an optional case-
     * insensitive title-substring filter.
     */
    public function titles(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $q = strtolower(trim($request->queryParam('q')));
        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 20));

        $typeIds = self::parseTypeIdsParam($request);
        $hasTypeFilter = $typeIds !== [];
        $v = strtolower(trim($request->queryParam('include_subtypes')));
        $includeSubtypes = in_array($v, ['1', 'true', 'yes', 'on'], true);

        // Compose the WHERE / FROM dynamically so the type filter
        // and subtype CTE only appear when actually needed.
        $whereType = '';
        $cteHead = '';
        $params = [':nook_id' => $nookId];
        if ($hasTypeFilter) {
            $tidPlaceholders = [];
            foreach ($typeIds as $i => $tid) {
                $ph = ':type_id_' . $i;
                $tidPlaceholders[] = $ph;
                $params[$ph] = $tid;
            }
            $tidList = implode(',', $tidPlaceholders);
            if ($includeSubtypes) {
                $cteHead = 'with recursive type_tree as ('
                    . ' select id from global.note_types where id in (' . $tidList . ') and nook_id = :nook_id'
                    . ' union all'
                    . ' select nt.id from global.note_types nt join type_tree tt on nt.parent_id = tt.id'
                    . ' where nt.nook_id = :nook_id'
                    . ') ';
                $whereType = ' and type_id in (select id from type_tree)';
            } else {
                $whereType = ' and type_id in (' . $tidList . ')';
            }
        }

        $whereQ = '';
        if ($q !== '') {
            $whereQ = ' and lower(title) like :q';
            $params[':q'] = '%' . $q . '%';
        }

        $sql = $cteHead
            . 'select id, title, type_id from global.notes '
            . 'where nook_id = :nook_id'
            . $whereType
            . $whereQ
            . ' order by created_at desc limit :limit';
        $stmt = $pdo->prepare($sql);
        foreach ($params as $p => $val) {
            $stmt->bindValue($p, $val);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $notes[] = [
                'id' => Row::str($r, 'id'),
                'title' => Row::str($r, 'title'),
                'type_id' => Row::str($r, 'type_id'),
            ];
        }
        return JsonResponse::ok(['notes' => $notes]);
    }

    /**
     * GET /nooks/{nookId}/notes
     *
     * Notes listing with filtering. Replaces the old
     * /note-types/{typeId}/notes endpoint — the type filter is now
     * a regular query param (`?type_id=X&include_subtypes=1`) which
     * reads honestly as "list notes filtered by type".
     *
     * Supported filters:
     *   ?type_id=<uuid>     filter by type. Omit for "all types".
     *   ?include_subtypes=1 include notes of descendant types via the
     *                       parent_id chain.
     *   ?q=<text>           title+content search (uses SearchQueryParser).
     *   ?search_mode=and|or how multi-word queries combine. Default and.
     *   ?attribute_filters=<json>  typed-attribute filtering.
     *   ?unlinked=1         only notes with zero links / mentions.
     *   ?sort=newest|oldest|updated_newest|updated_oldest
     *   ?limit=N            page size, max 200, default 50.
     *   ?cursor=<base64>    pagination cursor from a prior response.
     *
     * Response is lean by default (id/title/type_id/created_at/
     * updated_at + the 4 mention/link counts + search_rank). Pass
     * ?include=attributes when the caller actually needs the
     * structured attribute values inline (MCP/AI tooling and the
     * frontend's `view` attribute renderer use this); the default
     * stays small for list views.
     */
    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $typeIds = self::parseTypeIdsParam($request);
        $hasTypeFilter = $typeIds !== [];

        $v = strtolower(trim($request->queryParam('include_subtypes')));
        $includeSubtypes = in_array($v, ['1', 'true', 'yes', 'on'], true);

        $includeAttrs = in_array(
            strtolower(trim($request->queryParam('include'))),
            ['attributes', 'attrs'],
            true,
        );

        $limit = (int)trim($request->queryParam('limit'));
        if ($limit <= 0) {
            $limit = 50;
        }
        if ($limit > 200) {
            $limit = 200;
        }

        $cursor = trim($request->queryParam('cursor'));
        $cursorSortVal = '';
        $cursorId = '';
        if ($cursor !== '') {
            $decoded = base64_decode($cursor, true);
            if (!is_string($decoded) || $decoded === '') {
                throw new HttpError('cursor is invalid', 400);
            }
            $obj = json_decode($decoded, true);
            if (!is_array($obj)) {
                throw new HttpError('cursor is invalid', 400);
            }
            $cursorSortValRaw = $obj['created_at'] ?? '';
            $cursorIdRaw = $obj['id'] ?? '';
            $cursorSortVal = is_string($cursorSortValRaw) ? trim($cursorSortValRaw) : '';
            $cursorId = is_string($cursorIdRaw) ? trim($cursorIdRaw) : '';
            if ($cursorSortVal === '' || $cursorId === '' || !Uuid::isValid($cursorId)) {
                throw new HttpError('cursor is invalid', 400);
            }
        }

        if ($hasTypeFilter) {
            $tidPlaceholders = [];
            $checkParams = [':nook_id' => $nookId];
            foreach ($typeIds as $i => $tid) {
                $ph = ':id_' . $i;
                $tidPlaceholders[] = $ph;
                $checkParams[$ph] = $tid;
            }
            $tidList = implode(',', $tidPlaceholders);
            $typeCheck = $pdo->prepare('select count(*) from global.note_types where id in (' . $tidList . ') and nook_id = :nook_id');
            $typeCheck->execute($checkParams);
            if ((int)$typeCheck->fetchColumn() !== count($typeIds)) {
                throw new HttpError('type not found', 404);
            }
        }

        $sortParam = strtolower(trim($request->queryParam('sort')));
        if (!in_array($sortParam, ['newest', 'oldest', 'updated_newest', 'updated_oldest'], true)) {
            $sortParam = 'newest';
        }
        $sortCol = str_starts_with($sortParam, 'updated') ? 'updated_at' : 'created_at';
        $sortDir = str_ends_with($sortParam, 'oldest') ? 'asc' : 'desc';
        $cursorOp = $sortDir === 'asc' ? '>' : '<';
        $orderBy = "order by n.{$sortCol} {$sortDir}, n.id {$sortDir}";

        $q = strtolower(trim($request->queryParam('q')));
        $searchMode = strtolower(trim($request->queryParam('search_mode')));
        if (!in_array($searchMode, ['and', 'or'], true)) {
            $searchMode = 'and';
        }

        $search = SearchQueryParser::buildSearchClause($q, $searchMode);
        $whereSearch = $search['where'];
        $searchRank = $search['rank'] !== '0'
            ? '(' . $search['rank'] . ' + ln(1 + least(coalesce(ns.view_count, 0), 1000)) * 0.5)'
            : '0';
        $searchBindings = $search['bindings'];

        $orderByWithRank = $searchRank !== '0'
            ? "order by search_rank desc, n.{$sortCol} {$sortDir}, n.id {$sortDir}"
            : $orderBy;

        $attrFilter = $this->buildAttributeFilterClause($request->queryParam('attribute_filters'), $searchBindings);
        $whereAttrFilter = $attrFilter['where'];

        $unlinked = $request->queryParam('unlinked') === '1';
        $whereUnlinked = $unlinked
            ? 'and coalesce(ns.outgoing_links, 0) = 0 and coalesce(ns.incoming_links, 0) = 0
               and coalesce(ns.outgoing_mentions, 0) = 0 and coalesce(ns.incoming_mentions, 0) = 0'
            : '';

        $whereCursor = '';
        if ($cursor !== '') {
            $whereCursor = "and (n.{$sortCol}, n.id) {$cursorOp} (:cursor_sort_val::timestamptz, :cursor_id::uuid)";
        }

        $limitPlusOne = $limit + 1;

        // Only select `attributes` when the caller asked for it — keeps
        // the wire payload light for list views that just want title/id.
        $attrsCol = $includeAttrs ? 'n.attributes,' : '';
        $selectCols = "select n.id, n.title, n.type_id, {$attrsCol} n.created_at, n.updated_at,
                    coalesce(ns.outgoing_mentions, 0) as outgoing_mentions_count,
                    coalesce(ns.incoming_mentions, 0) as incoming_mentions_count,
                    coalesce(ns.outgoing_links, 0) as outgoing_links_count,
                    coalesce(ns.incoming_links, 0) as incoming_links_count,
                    {$searchRank} as search_rank";
        $joinCounts = 'left join global.note_stats ns on ns.note_id = n.id';

        $tidPlaceholders = [];
        foreach ($typeIds as $i => $tid) {
            $tidPlaceholders[] = ':type_id_' . $i;
        }
        $tidList = implode(',', $tidPlaceholders);

        if (!$hasTypeFilter) {
            $sql = $selectCols . ' from global.notes n ' . $joinCounts
                . ' where n.nook_id = :nook_id ' . $whereCursor
                . ' ' . $whereSearch
                . ' ' . $whereAttrFilter
                . ' ' . $whereUnlinked
                . ' ' . $orderByWithRank
                . ' limit :limit';
            $stmt = $pdo->prepare($sql);
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
        } elseif ($includeSubtypes) {
            $sql = 'with recursive type_tree as ('
                . ' select id from global.note_types where id in (' . $tidList . ') and nook_id = :nook_id'
                . ' union all'
                . ' select nt.id from global.note_types nt join type_tree tt on nt.parent_id = tt.id'
                . ' where nt.nook_id = :nook_id'
                . ') '
                . $selectCols . ' from global.notes n ' . $joinCounts
                . ' where n.nook_id = :nook_id and n.type_id in (select id from type_tree) '
                . $whereCursor
                . ' ' . $whereSearch
                . ' ' . $whereAttrFilter
                . ' ' . $whereUnlinked
                . ' ' . $orderByWithRank
                . ' limit :limit';
            $stmt = $pdo->prepare($sql);
            $stmt->bindValue(':nook_id', $nookId);
            foreach ($typeIds as $i => $tid) {
                $stmt->bindValue(':type_id_' . $i, $tid);
            }
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
        } else {
            $sql = $selectCols . ' from global.notes n ' . $joinCounts
                . ' where n.nook_id = :nook_id and n.type_id in (' . $tidList . ') '
                . $whereCursor
                . ' ' . $whereSearch
                . ' ' . $whereAttrFilter
                . ' ' . $whereUnlinked
                . ' ' . $orderByWithRank
                . ' limit :limit';
            $stmt = $pdo->prepare($sql);
            $stmt->bindValue(':nook_id', $nookId);
            foreach ($typeIds as $i => $tid) {
                $stmt->bindValue(':type_id_' . $i, $tid);
            }
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
        }

        foreach ($searchBindings as $param => $val) {
            $stmt->bindValue($param, $val);
        }
        if ($cursor !== '') {
            $stmt->bindValue(':cursor_sort_val', $cursorSortVal);
            $stmt->bindValue(':cursor_id', $cursorId);
        }
        $stmt->execute();

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $nextCursor = '';
        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            $rows = array_slice($rows, 0, $limit);
        }

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $entry = [
                'id' => Row::str($r, 'id'),
                'nook_id' => $nookId,
                'title' => Row::str($r, 'title'),
                'type_id' => Row::str($r, 'type_id'),
                'created_at' => Row::str($r, 'created_at'),
                'updated_at' => Row::str($r, 'updated_at'),
                'outgoing_mentions_count' => Row::int($r, 'outgoing_mentions_count'),
                'incoming_mentions_count' => Row::int($r, 'incoming_mentions_count'),
                'outgoing_links_count' => Row::int($r, 'outgoing_links_count'),
                'incoming_links_count' => Row::int($r, 'incoming_links_count'),
            ];
            if ($includeAttrs) {
                $entry['attributes'] = Row::decodeJsonObject($r['attributes'] ?? null);
            }
            $notes[] = $entry;
        }

        if ($hasMore && $rows !== []) {
            $last = $rows[count($rows) - 1];
            if (is_array($last)) {
                $lastSortVal = is_scalar($last[$sortCol] ?? null) ? (string)$last[$sortCol] : '';
                $lastId = Row::str($last, 'id');
                if ($lastSortVal !== '' && $lastId !== '' && Uuid::isValid($lastId)) {
                    $payload = json_encode(['created_at' => $lastSortVal, 'id' => $lastId]);
                    if (is_string($payload)) {
                        $nextCursor = base64_encode($payload);
                    }
                }
            }
        }

        // Heading matches for q-search (only on first page so the
        // section is shown once at the top, not repeated per cursor).
        $headingMatches = [];
        if ($q !== '' && $cursor === '') {
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
                    "select h.note_id, h.level, h.text, h.position, n.title as note_title
                     from global.note_headings h
                     join global.notes n on n.id = h.note_id
                     where h.nook_id = :nook_id and {$hWhere}
                     order by similarity(lower(h.text), :hq_full) desc
                     limit 10"
                );
                $hStmt->bindValue(':nook_id', $nookId);
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
                    $headingMatches[] = [
                        'note_id' => Row::str($hr, 'note_id'),
                        'note_title' => Row::str($hr, 'note_title'),
                        'level' => Row::int($hr, 'level'),
                        'text' => Row::str($hr, 'text'),
                        'position' => Row::int($hr, 'position'),
                    ];
                }
            }
        }

        return JsonResponse::ok([
            'notes' => $notes,
            'next_cursor' => $nextCursor,
            'heading_matches' => $headingMatches,
        ]);
    }

    /**
     * Parse attribute_filters JSON into a SQL WHERE clause +
     * bindings. Moved here from NoteTypesController when the type-
     * filtered listing migrated to /notes?type_id=X.
     *
     * @param array<string, string> &$bindings  bindings the caller will bind on the stmt
     * @return array{where: string}
     */
    private function buildAttributeFilterClause(string $raw, array &$bindings): array
    {
        $raw = trim($raw);
        if ($raw === '') {
            return ['where' => ''];
        }
        $filters = json_decode($raw, true);
        if (!is_array($filters) || $filters === []) {
            return ['where' => ''];
        }

        $clauses = [];
        $idx = 0;
        foreach ($filters as $f) {
            if (!is_array($f)) {
                continue;
            }
            $attrIdRaw = $f['attribute_id'] ?? '';
            $attrId = is_scalar($attrIdRaw) ? trim((string)$attrIdRaw) : '';
            $opRaw = $f['op'] ?? '';
            $op = strtolower(is_scalar($opRaw) ? trim((string)$opRaw) : '');
            $value = $f['value'] ?? null;
            $scalarValue = is_scalar($value) ? (string)$value : '';

            if ($attrId === '' || !Uuid::isValid($attrId)) {
                continue;
            }

            $paramKey = ':af_' . $idx;
            $jsonPath = "n.attributes->>'" . $attrId . "'";
            $jsonPathObj = "n.attributes->'" . $attrId . "'";
            $idx++;

            switch ($op) {
                case 'eq':
                    $clauses[] = "{$jsonPath} = {$paramKey}";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'neq':
                    $clauses[] = "({$jsonPath} IS NULL OR {$jsonPath} != {$paramKey})";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'gt':
                    $clauses[] = "global.safe_numeric({$jsonPath}) > {$paramKey}::numeric";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'gte':
                    $clauses[] = "global.safe_numeric({$jsonPath}) >= {$paramKey}::numeric";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'lt':
                    $clauses[] = "global.safe_numeric({$jsonPath}) < {$paramKey}::numeric";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'lte':
                    $clauses[] = "global.safe_numeric({$jsonPath}) <= {$paramKey}::numeric";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'date_gt':
                    $clauses[] = "({$jsonPath})::date > {$paramKey}::date";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'date_gte':
                    $clauses[] = "({$jsonPath})::date >= {$paramKey}::date";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'date_lt':
                    $clauses[] = "({$jsonPath})::date < {$paramKey}::date";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'date_lte':
                    $clauses[] = "({$jsonPath})::date <= {$paramKey}::date";
                    $bindings[$paramKey] = $scalarValue;
                    break;
                case 'contains':
                    $clauses[] = "{$jsonPath} ILIKE {$paramKey}";
                    $bindings[$paramKey] = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $scalarValue) . '%';
                    break;
                case 'starts_with':
                    $clauses[] = "{$jsonPath} ILIKE {$paramKey}";
                    $bindings[$paramKey] = str_replace(['%', '_'], ['\\%', '\\_'], $scalarValue) . '%';
                    break;
                case 'is_null':
                    $clauses[] = "{$jsonPath} IS NULL";
                    break;
                case 'is_not_null':
                    $clauses[] = "{$jsonPath} IS NOT NULL";
                    break;
                case 'in':
                    if (is_array($value) && $value !== []) {
                        $inPlaceholders = [];
                        foreach ($value as $vi => $vv) {
                            $pk = $paramKey . '_' . $vi;
                            $inPlaceholders[] = $pk;
                            $bindings[$pk] = is_scalar($vv) ? (string)$vv : '';
                        }
                        $clauses[] = "{$jsonPath} IN (" . implode(', ', $inPlaceholders) . ")";
                    }
                    break;
                case 'overlaps':
                    if (is_array($value)) {
                        $fromRaw = $value['from'] ?? '';
                        $from = is_scalar($fromRaw) ? (string)$fromRaw : '';
                        $toRaw = $value['to'] ?? '';
                        $to = is_scalar($toRaw) ? (string)$toRaw : '';
                        if ($from !== '' && $to !== '') {
                            $pkFrom = $paramKey . '_from';
                            $pkTo = $paramKey . '_to';
                            $clauses[] = "({$jsonPathObj}->>'from')::date <= {$pkTo}::date AND ({$jsonPathObj}->>'to')::date >= {$pkFrom}::date";
                            $bindings[$pkFrom] = $from;
                            $bindings[$pkTo] = $to;
                        }
                    }
                    break;
            }
        }

        if ($clauses === []) {
            return ['where' => ''];
        }
        return ['where' => 'and ' . implode(' and ', $clauses)];
    }

    public function presence(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        $userId = $user->id;
        NookAccess::requireMember($pdo, $user, $nookId);

        // Get current version
        $vStmt = $pdo->prepare('select version from global.notes where id = :id and nook_id = :nook_id');
        $vStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $version = $vStmt->fetchColumn();
        if ($version === false) {
            throw new HttpError('note not found', 404);
        }

        // Upsert viewer presence
        $pdo->prepare(
            "insert into global.note_viewers (note_id, nook_id, user_id, last_seen_at)
             values (:note_id, :nook_id, :user_id, now())
             on conflict (note_id, user_id) do update set last_seen_at = now(), nook_id = excluded.nook_id"
        )->execute([':note_id' => $noteId, ':nook_id' => $nookId, ':user_id' => $userId]);

        // Record view (once per user per note per day — deduped by PK, stats updated via trigger)
        $pdo->prepare(
            "insert into global.note_views (note_id, nook_id, user_id, viewed_date, count)
             values (:note_id, :nook_id, :user_id, current_date, 1)
             on conflict (note_id, user_id, viewed_date) do nothing"
        )->execute([':note_id' => $noteId, ':nook_id' => $nookId, ':user_id' => $userId]);

        // Get other viewers (active within last 60s, excluding self)
        $vwStmt = $pdo->prepare(
            "select nv.user_id, u.first_name, u.last_name, u.nickname
             from global.note_viewers nv
             left join global.users u on u.id = nv.user_id
             where nv.note_id = :note_id
               and nv.user_id != :user_id
               and nv.last_seen_at > now() - interval '60 seconds'"
        );
        $vwStmt->execute([':note_id' => $noteId, ':user_id' => $userId]);
        $viewers = [];
        foreach ($vwStmt->fetchAll(PDO::FETCH_ASSOC) as $v) {
            if (!is_array($v)) {
                continue;
            }
            $viewers[] = [
                'user_id' => Row::str($v, 'user_id'),
                'user_name' => trim(Row::str($v, 'nickname') !== '' ? Row::str($v, 'nickname') : (Row::str($v, 'first_name') . ' ' . Row::str($v, 'last_name'))),
            ];
        }

        return JsonResponse::ok([
            'version' => is_scalar($version) ? (int)$version : 0,
            'viewers' => $viewers,
        ]);
    }

    public function get(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select n.id, n.title, n.content, n.type_id, n.attributes, n.archive, n.version, '
            . 'n.created_at, n.updated_at, '
            . 'coalesce(nullif(cu.nickname, \'\'), trim(cu.first_name || \' \' || cu.last_name)) as created_by_name '
            . 'from global.notes n '
            . 'left join global.users cu on cu.id = n.created_by '
            . 'where n.nook_id = :nook_id and n.id = :id'
        );
        $stmt->execute([':nook_id' => $nookId, ':id' => $noteId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('note not found', 404);
        }

        $detail = NoteDetailRow::fromRow($r);

        // Optional: extract a single section starting at a character offset.
        // Returns content from that position to the next heading of same or higher level.
        $sectionAt = trim($request->queryParam('section_at'));
        $sectionContent = null;
        if ($sectionAt !== '' && ctype_digit($sectionAt)) {
            $pos = (int)$sectionAt;
            $sectionContent = self::extractSection($detail->content, $pos);
        }

        // Total view count for this note
        $vcStmt = $pdo->prepare('select coalesce(sum(count), 0) from global.note_views where note_id = :note_id');
        $vcStmt->execute([':note_id' => $noteId]);
        $vcCol = $vcStmt->fetchColumn();
        $viewCount = is_scalar($vcCol) ? (int)$vcCol : 0;

        $note = $detail->toArray() + [
            'nook_id' => $nookId,
            'view_count' => $viewCount,
        ];

        if ($sectionContent !== null) {
            $note['section'] = $sectionContent;
        }

        // Include file metadata from note_files. Each entry carries a
        // session-bound HMAC `signed_url` so the frontend can `<img src=…>`
        // straight at /files/ — nginx + qjs verify in-process, no PHP
        // roundtrip per render and Cache-Control: private kicks in. The
        // 2hr TTL matches AttributeFilesController so behavior is uniform.
        // The version component of object_key is part of the HMAC canonical
        // input — a v1 URL can never resolve to v2 content even if leaked.
        $nfStmt = $pdo->prepare(
            'select attribute_id, filename, extension, filesize, mime_type, checksum, file_version, object_key '
            . 'from global.note_files where note_id = :note_id'
        );
        $nfStmt->execute([':note_id' => $noteId]);
        $nfRows = $nfStmt->fetchAll(PDO::FETCH_ASSOC);
        $files = [];
        if ($nfRows !== []) {
            $sessionId = $this->extractSessionId($request);
            $signer    = UrlSigner::fromEnv();
            foreach ($nfRows as $nf) {
                if (!is_array($nf)) {
                    continue;
                }
                $file = NoteFileMetadataRow::fromRow($nf);
                if ($file->attributeId === null || $file->attributeId === '') {
                    continue;
                }
                $entry = $file->toNoteDetailEntry();
                $entry['signed_url'] = $this->signedInlineUrl($signer, $sessionId, $file);
                $files[$file->attributeId] = $entry;
            }
        }
        $note['files'] = $files === [] ? (object)[] : $files;

        // Include TOC (headings) for this note
        $note['headings'] = array_map(
            static fn(NoteHeadingRow $h) => $h->toArray(),
            self::fetchHeadingRows($pdo, $nookId, $noteId),
        );

        return JsonResponse::ok(['note' => $note]);
    }

    /**
     * GET /nooks/{nookId}/notes/{noteId}/summary
     * Lightweight note metadata: title, type, attributes, headings — no content.
     * Designed for AI agents to understand note structure without loading full content.
     */
    public function summary(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select id, title, type_id, attributes, version, created_at, updated_at '
            . 'from global.notes where nook_id = :nook_id and id = :id'
        );
        $stmt->execute([':nook_id' => $nookId, ':id' => $noteId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('note not found', 404);
        }

        $headings = array_map(
            static fn(NoteHeadingRow $h) => $h->toArray(),
            self::fetchHeadingRows($pdo, $nookId, $noteId),
        );

        return JsonResponse::ok([
            'summary' => NoteSummaryRow::fromRow($r)->toArray() + [
                'nook_id' => $nookId,
                'headings' => $headings,
            ],
        ]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = $context->userId();

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $payload = CreateNoteRequest::fromJson($request->jsonBody());

        if ($payload->typeId !== null) {
            $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $payload->typeId, ':nook_id' => $nookId]);
            if (!$typeCheck->fetchColumn()) {
                throw new HttpError('type not found', 404);
            }

            if ($payload->attributes !== []) {
                AttributeValidator::validateNoteAttributesForType($pdo, $nookId, $payload->typeId, $payload->attributes);
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                "insert into global.notes (nook_id, created_by, title, content, type_id, attributes, actor) "
                . "values (:nook_id, :created_by, :title, :content, :type_id, :attributes::jsonb, :actor) returning id, created_at"
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':created_by' => $userId,
                ':title' => $payload->title,
                ':content' => $payload->content,
                ':type_id' => $payload->typeId,
                ':attributes' => json_encode($payload->attributes === [] ? (object)[] : $payload->attributes),
                ':actor' => $context->actor(),
            ]);

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create note', 500);
            }
            $created = CreatedNoteRow::fromRow($row);

            $this->mentions->syncMentions($pdo, $nookId, $created->id, $payload->content, $userId);
            $this->headings->syncHeadings($pdo, $nookId, $created->id, $payload->content);

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => $created->id,
                    'nook_id' => $nookId,
                    'title' => $payload->title,
                    'content' => $payload->content,
                    'type_id' => $payload->typeId ?? '',
                    'attributes' => $payload->attributes === [] ? (object)[] : $payload->attributes,
                    'archive' => (object)[],
                    'created_at' => $created->createdAt,
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function update(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        $userId = $user->id;
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $role = NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $payload = UpdateNoteRequest::fromJson($request->jsonBody());

        $allowed = false;
        if ($role === NookRole::Owner) {
            $allowed = true;
        } else {
            $c = $pdo->prepare('select created_by from global.notes where id = :id and nook_id = :nook_id');
            $c->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $createdBy = $c->fetchColumn();
            if (is_scalar($createdBy) && (string)$createdBy === $userId) {
                $allowed = true;
            }
        }

        if (!$allowed) {
            throw new HttpError('forbidden', 403);
        }

        $existingStmt = $pdo->prepare('select type_id, attributes, archive from global.notes where id = :id and nook_id = :nook_id');
        $existingStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $existingRow = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($existingRow)) {
            throw new HttpError('note not found', 404);
        }

        $existingTypeId = is_scalar($existingRow['type_id'] ?? null) ? trim((string)$existingRow['type_id']) : '';
        $existingAttributes = Row::decodeJsonObject($existingRow['attributes'] ?? null);
        $existingArchive = Row::decodeJsonObject($existingRow['archive'] ?? null);

        // Resolve type_id with tri-state semantics from the payload:
        //   not provided → keep existing; provided as null/empty → clear; provided as UUID → set.
        $typeId = $existingTypeId !== '' ? $existingTypeId : null;
        if ($payload->typeIdProvided) {
            $typeId = $payload->typeId;
        }

        // Merge incoming attribute values (if provided) into existing attributes.
        // Values of null delete the key; other values overwrite.
        $attributes = $existingAttributes;
        if ($payload->attributes !== null) {
            foreach ($payload->attributes as $k => $v) {
                if ($v === null) {
                    unset($attributes[$k]);
                } else {
                    $attributes[$k] = $v;
                }
            }
        }
        $archive = $existingArchive;

        // Title: payload provides a non-empty value, or we fall back to existing.
        $title = $payload->title;
        if ($title === null) {
            $existingTitleStmt = $pdo->prepare('select title from global.notes where id = :id and nook_id = :nook_id');
            $existingTitleStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $existingTitle = $existingTitleStmt->fetchColumn();
            $title = is_string($existingTitle) ? trim($existingTitle) : '';
            if ($title === '') {
                throw new HttpError('title is required', 400);
            }
        }

        $content = $payload->content ?? '';

        if ($typeId !== null) {
            $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            if (!$typeCheck->fetchColumn()) {
                throw new HttpError('type not found', 404);
            }
        }

        // Validate incoming attribute values against type schema
        $effectiveTypeId = $typeId ?? $existingTypeId;
        if ($payload->attributes !== null && $effectiveTypeId !== '') {
            AttributeValidator::validateNoteAttributesForType($pdo, $nookId, $effectiveTypeId, $payload->attributes);
        }

        // Type switch: bidirectional archive/attributes swap
        $newTypeIdStr = is_string($typeId) ? $typeId : '';
        if ($newTypeIdStr !== $existingTypeId) {
            $visibleUuids = [];
            if ($newTypeIdStr !== '') {
                $visibleUuids = $this->resolveVisibleAttributeIds($pdo, $nookId, $newTypeIdStr);
            }

            $newAttributes = [];
            $newArchive = [];

            // Keys in current attributes: keep if visible, else move to archive
            foreach ($attributes as $k => $v) {
                if (isset($visibleUuids[$k])) {
                    $newAttributes[$k] = $v;
                } else {
                    $newArchive[$k] = $v;
                }
            }

            // Keys in current archive: restore if visible, else keep in archive
            foreach ($archive as $k => $v) {
                if (isset($visibleUuids[$k])) {
                    // Only restore from archive if not already set in attributes
                    if (!isset($newAttributes[$k])) {
                        $newAttributes[$k] = $v;
                    }
                } else {
                    $newArchive[$k] = $v;
                }
            }

            $attributes = $newAttributes;
            $archive = $newArchive;
        }

        // Optimistic locking: if expected_version is provided, check it matches current
        if ($payload->expectedVersion !== null) {
            $vStmt = $pdo->prepare('select version from global.notes where id = :id and nook_id = :nook_id');
            $vStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $vCol = $vStmt->fetchColumn();
            $currentVersion = is_scalar($vCol) ? (int)$vCol : 0;
            if ($currentVersion !== $payload->expectedVersion) {
                return JsonResponse::error('note was edited in the meantime', 409, [
                    'current_version' => $currentVersion,
                    'expected_version' => $payload->expectedVersion,
                ]);
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'update global.notes set title = :title, content = :content, type_id = :type_id, '
                . 'attributes = :attributes::jsonb, archive = :archive::jsonb, '
                . 'updated_at = now() where id = :id and nook_id = :nook_id returning id, version, created_at, updated_at'
            );
            $stmt->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':title' => $title,
                ':content' => $content,
                ':type_id' => $typeId,
                ':attributes' => json_encode($attributes === [] ? (object)[] : $attributes),
                ':archive' => json_encode($archive === [] ? (object)[] : $archive),
            ]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('note not found', 404);
            }

            $userId = $user->id;
            $this->mentions->syncMentions($pdo, $nookId, $noteId, $content, $userId);
            $this->headings->syncHeadings($pdo, $nookId, $noteId, $content);

            $pdo->commit();

            $id = $row['id'] ?? '';
            $createdAt = $row['created_at'] ?? '';

            return JsonResponse::ok([
                'note' => [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => $content,
                    'type_id' => is_string($typeId) ? $typeId : '',
                    'attributes' => $attributes === [] ? (object)[] : $attributes,
                    'archive' => $archive === [] ? (object)[] : $archive,
                    'version' => Row::int($row, 'version'),
                    'created_at' => is_scalar($createdAt) ? (string)$createdAt : '',
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        $userId = $user->id;
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $role = NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $allowed = false;
        if ($role === NookRole::Owner) {
            $allowed = true;
        } else {
            $c = $pdo->prepare('select created_by from global.notes where id = :id and nook_id = :nook_id');
            $c->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $createdBy = $c->fetchColumn();
            if (is_scalar($createdBy) && (string)$createdBy === $userId) {
                $allowed = true;
            }
        }

        if (!$allowed) {
            throw new HttpError('forbidden', 403);
        }

        $stmt = $pdo->prepare('delete from global.notes where id = :id and nook_id = :nook_id returning id');
        $stmt->execute([
            ':id' => $noteId,
            ':nook_id' => $nookId,
        ]);
        $deletedId = $stmt->fetchColumn();
        if (!is_scalar($deletedId) || (string)$deletedId === '') {
            throw new HttpError('note not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'note_id' => (string)$deletedId,
        ]);
    }

    public function mentions(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        // Cross-nook: return mentions from any nook the user is a member of
        $outgoingStmt = $pdo->prepare(
            'select m.target_note_id as note_id, n.title as note_title, n.nook_id, m.link_title, m.position '
            . 'from global.note_mentions m '
            . 'join global.notes n on n.id = m.target_note_id '
            . 'join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id '
            . 'where m.source_note_id = :source_note_id '
            . 'order by m.position asc'
        );
        $outgoingStmt->execute([
            ':source_note_id' => $noteId,
            ':user_id' => $user->id,
        ]);
        $outgoingRows = $outgoingStmt->fetchAll(PDO::FETCH_ASSOC);

        $incomingStmt = $pdo->prepare(
            'select m.source_note_id as note_id, n.title as note_title, n.nook_id, m.link_title, m.position '
            . 'from global.note_mentions m '
            . 'join global.notes n on n.id = m.source_note_id '
            . 'join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id '
            . 'where m.target_note_id = :target_note_id '
            . 'order by m.position asc'
        );
        $incomingStmt->execute([
            ':target_note_id' => $noteId,
            ':user_id' => $user->id,
        ]);
        $incomingRows = $incomingStmt->fetchAll(PDO::FETCH_ASSOC);

        $normalize = static function (array $r): array {
            return [
                'note_id' => Row::str($r, 'note_id'),
                'nook_id' => Row::str($r, 'nook_id'),
                'note_title' => Row::str($r, 'note_title'),
                'link_title' => Row::str($r, 'link_title'),
                'position' => Row::int($r, 'position'),
            ];
        };

        $outgoing = [];
        foreach ($outgoingRows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $outgoing[] = $normalize($r);
        }

        $incoming = [];
        foreach ($incomingRows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $incoming[] = $normalize($r);
        }

        return JsonResponse::ok([
            'outgoing' => $outgoing,
            'incoming' => $incoming,
        ]);
    }

    public function historySnapshot(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        $historyId = trim($request->routeParam('historyId'));
        if ($historyId === '') {
            throw new HttpError('historyId is required', 400);
        }

        NookAccess::requireMember($pdo, $user, $nookId);

        // historyId can be a numeric ID or "v{number}" for version lookup
        if (str_starts_with($historyId, 'v') && ctype_digit(substr($historyId, 1))) {
            $version = (int)substr($historyId, 1);
            $stmt = $pdo->prepare(
                'select am.id, am.version, am.action, am.actor, am.user_id, am.created_at,
                        u.first_name, u.last_name, u.nickname,
                        ad.data
                 from global.audit_meta am
                 join global.audit_data ad on ad.meta_id = am.id
                 left join global.users u on u.id = am.user_id
                 where am.version = :version
                   and am.table_name = :table_name
                   and am.entity_id = :entity_id
                   and am.nook_id = :nook_id'
            );
            $stmt->execute([
                ':version' => $version,
                ':table_name' => 'notes',
                ':entity_id' => $noteId,
                ':nook_id' => $nookId,
            ]);
        } elseif (ctype_digit($historyId)) {
            $stmt = $pdo->prepare(
                'select am.id, am.version, am.action, am.actor, am.user_id, am.created_at,
                        u.first_name, u.last_name, u.nickname,
                        ad.data
                 from global.audit_meta am
                 join global.audit_data ad on ad.meta_id = am.id
                 left join global.users u on u.id = am.user_id
                 where am.id = :history_id
                   and am.table_name = :table_name
                   and am.entity_id = :entity_id
                   and am.nook_id = :nook_id'
            );
            $stmt->execute([
                ':history_id' => (int)$historyId,
                ':table_name' => 'notes',
                ':entity_id' => $noteId,
                ':nook_id' => $nookId,
            ]);
        } else {
            throw new HttpError('historyId must be numeric or v{number}', 400);
        }
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('snapshot not found', 404);
        }

        $dataDecoded = json_decode(Row::str($r, 'data', '{}'), true);
        /** @var array<string, mixed> $data */
        $data = is_array($dataDecoded) ? $dataDecoded : [];

        return JsonResponse::ok([
            'snapshot' => [
                'history_id' => Row::int($r, 'id'),
                'version' => Row::int($r, 'version'),
                'action' => Row::str($r, 'action'),
                'actor' => Row::str($r, 'actor', 'user'),
                'user_id' => Row::str($r, 'user_id'),
                'user_name' => trim(Row::str($r, 'nickname') !== '' ? Row::str($r, 'nickname') : (Row::str($r, 'first_name') . ' ' . Row::str($r, 'last_name'))),
                'created_at' => Row::str($r, 'created_at'),
                'note' => [
                    'id' => Row::str($data, 'id'),
                    'title' => Row::str($data, 'title'),
                    'content' => Row::str($data, 'content'),
                    'type_id' => Row::str($data, 'type_id'),
                    'attributes' => is_array($data['attributes'] ?? null)
                        ? $data['attributes']
                        : (is_string($data['attributes'] ?? null)
                            ? (json_decode($data['attributes'], true) ?? [])
                            : []),
                ],
            ],
        ]);
    }

    /**
     * GET /nooks/{nookId}/notes/{noteId}/diff?from={version}&to={version}
     * Compare two versions of a note. Returns unified diff of content + both versions' metadata.
     * If "to" is omitted, compares against the current version.
     */
    public function diff(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $fromVersion = trim($request->queryParam('from'));
        $toVersion = trim($request->queryParam('to'));

        if ($fromVersion === '' || !ctype_digit($fromVersion)) {
            throw new HttpError('from version is required (numeric)', 400);
        }

        // Load "from" snapshot
        $fromData = $this->loadVersionSnapshot($pdo, $nookId, $noteId, (int)$fromVersion);
        if ($fromData === null) {
            throw new HttpError('from version not found', 404);
        }

        // Load "to" snapshot — either a specific version or current
        if ($toVersion !== '' && ctype_digit($toVersion)) {
            $toData = $this->loadVersionSnapshot($pdo, $nookId, $noteId, (int)$toVersion);
            if ($toData === null) {
                throw new HttpError('to version not found', 404);
            }
        } else {
            // Use current note content
            $stmt = $pdo->prepare(
                'select title, content, type_id, attributes, version from global.notes where id = :id and nook_id = :nook_id'
            );
            $stmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $cur = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($cur)) {
                throw new HttpError('note not found', 404);
            }
            $toData = [
                'version' => Row::int($cur, 'version'),
                'title' => Row::str($cur, 'title'),
                'content' => Row::str($cur, 'content'),
                'type_id' => Row::str($cur, 'type_id'),
                'attributes' => Row::decodeJsonObject($cur['attributes'] ?? null),
            ];
        }

        $diff = DiffService::unifiedDiff($fromData['content'], $toData['content']);

        return JsonResponse::ok([
            'from' => [
                'version' => $fromData['version'],
                'title' => $fromData['title'],
                'type_id' => $fromData['type_id'],
                'attributes' => $fromData['attributes'],
            ],
            'to' => [
                'version' => $toData['version'],
                'title' => $toData['title'],
                'type_id' => $toData['type_id'],
                'attributes' => $toData['attributes'],
            ],
            'content_diff' => $diff['diff'],
            'hunks' => $diff['hunks'],
            'stats' => $diff['stats'],
        ]);
    }

    /**
     * Load a note's content at a specific version from the audit trail.
     * @return array{version: int, title: string, content: string, type_id: string, attributes: array<string, mixed>}|null
     */
    private function loadVersionSnapshot(PDO $pdo, string $nookId, string $noteId, int $version): ?array
    {
        $stmt = $pdo->prepare(
            'select ad.data from global.audit_meta am '
            . 'join global.audit_data ad on ad.meta_id = am.id '
            . 'where am.version = :version and am.table_name = :table and am.entity_id = :note_id and am.nook_id = :nook_id'
        );
        $stmt->execute([
            ':version' => $version,
            ':table' => 'notes',
            ':note_id' => $noteId,
            ':nook_id' => $nookId,
        ]);
        $raw = $stmt->fetchColumn();
        if (!is_scalar($raw)) {
            return null;
        }

        $data = json_decode((string)$raw, true);
        if (!is_array($data)) {
            return null;
        }

        return [
            'version' => $version,
            'title' => Row::str($data, 'title'),
            'content' => Row::str($data, 'content'),
            'type_id' => Row::str($data, 'type_id'),
            'attributes' => Row::decodeJsonObject($data['attributes'] ?? null),
        ];
    }

    public function history(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            "select am.id, am.version, am.action, am.actor, am.table_name, am.user_id, am.created_at,
                    u.first_name, u.last_name, u.nickname,
                    case when am.table_name in ('note_links', 'note_cross_links') then
                        case when ad.data->>'source_note_id' = :note_id2 then ad.data->>'target_note_id'
                             else ad.data->>'source_note_id' end
                    end as linked_note_id,
                    case when am.table_name in ('note_links', 'note_cross_links') then
                        (select n.title from global.notes n where n.id = case
                            when ad.data->>'source_note_id' = :note_id3 then (ad.data->>'target_note_id')::uuid
                            else (ad.data->>'source_note_id')::uuid
                        end)
                    end as linked_note_title,
                    case when am.table_name = 'note_links' and ad.data->>'predicate_id' is not null then
                        case when ad.data->>'source_note_id' = :note_id4
                            then (select forward_label from global.link_predicates where id = (ad.data->>'predicate_id')::uuid)
                            else (select reverse_label from global.link_predicates where id = (ad.data->>'predicate_id')::uuid)
                        end
                    end as link_label
             from global.audit_meta_refs r
             join global.audit_meta am on am.id = r.meta_id
             left join global.audit_data ad on ad.meta_id = am.id
             left join global.users u on u.id = am.user_id
             where r.note_id = :note_id
               and am.nook_id in (select nook_id from global.nook_members where user_id = :user_id)
             order by am.version desc, r.meta_id desc
             limit 10"
        );
        $stmt->execute([
            ':note_id' => $noteId,
            ':note_id2' => $noteId,
            ':note_id3' => $noteId,
            ':note_id4' => $noteId,
            ':user_id' => $user->id,
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $history = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $tableName = Row::str($r, 'table_name', 'notes');
            $isLink = $tableName === 'note_links' || $tableName === 'note_cross_links';
            $isFile = $tableName === 'note_files';

            $type = $isLink ? 'link' : ($isFile ? 'file' : 'note');
            $entry = [
                'id' => Row::int($r, 'id'),
                'version' => Row::int($r, 'version'),
                'action' => Row::str($r, 'action'),
                'actor' => Row::str($r, 'actor', 'user'),
                'type' => $type,
                'user_id' => Row::str($r, 'user_id'),
                'user_name' => trim(Row::str($r, 'nickname') !== '' ? Row::str($r, 'nickname') : (Row::str($r, 'first_name') . ' ' . Row::str($r, 'last_name'))),
                'created_at' => Row::str($r, 'created_at'),
            ];
            if ($isLink) {
                $linkedNoteId = Row::nullStr($r, 'linked_note_id');
                if ($linkedNoteId !== null) {
                    $entry['linked_note_id'] = $linkedNoteId;
                }
                $linkedNoteTitle = Row::nullStr($r, 'linked_note_title');
                if ($linkedNoteTitle !== null) {
                    $entry['linked_note_title'] = $linkedNoteTitle;
                }
                $linkLabel = Row::nullStr($r, 'link_label');
                if ($linkLabel !== null) {
                    $entry['link_label'] = $linkLabel;
                }
            }
            if ($isFile) {
                // Extract file metadata from audit_data for display
                $metaId = Row::int($r, 'id');
                $dataStmt = $pdo->prepare('select data from global.audit_data where meta_id = :meta_id');
                $dataStmt->execute([':meta_id' => $metaId]);
                $dataRow = $dataStmt->fetch(PDO::FETCH_ASSOC);
                if (is_array($dataRow) && is_scalar($dataRow['data'] ?? null)) {
                    $fileData = json_decode((string)$dataRow['data'], true);
                    if (is_array($fileData)) {
                        $entry['filename'] = Row::str($fileData, 'filename');
                        $entry['filesize'] = is_numeric($fileData['filesize'] ?? null) ? (int)$fileData['filesize'] : 0;
                        $entry['mime_type'] = Row::str($fileData, 'mime_type');
                    }
                }
            }
            $history[] = $entry;
        }

        return JsonResponse::ok(['history' => $history]);
    }

    /**
     * Fetch the heading rows for a note as typed DTOs.
     *
     * @return list<NoteHeadingRow>
     */
    private static function fetchHeadingRows(PDO $pdo, string $nookId, string $noteId): array
    {
        $stmt = $pdo->prepare(
            'select level, text, position from global.note_headings '
            . 'where note_id = :note_id and nook_id = :nook_id order by position asc'
        );
        $stmt->execute([':note_id' => $noteId, ':nook_id' => $nookId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            if (is_array($r)) {
                $out[] = NoteHeadingRow::fromRow($r);
            }
        }
        return $out;
    }

    /**
     * Resolve the set of attribute UUIDs visible to a type (own + inherited).
     * @return array<string, true>
     */
    private function resolveVisibleAttributeIds(PDO $pdo, string $nookId, string $typeId): array
    {
        $stmt = $pdo->prepare(
            'with recursive type_tree as (
                select id from global.note_types where id = :type_id and nook_id = :nook_id
                union all
                select t.parent_id from global.note_types t
                join type_tree tt on t.id = tt.id
                where t.parent_id is not null
            )
            select ta.id from global.type_attributes ta
            join type_tree tt on ta.type_id = tt.id'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->execute();

        $ids = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            if (is_scalar($id)) {
                $ids[(string)$id] = true;
            }
        }
        return $ids;
    }
    /**
     * Extract a section from markdown starting at a character offset.
     * Returns content from that position to the next heading of the same
     * or higher level (fewer #'s), or end of content.
     */
    private static function extractSection(string $content, int $position): string
    {
        if ($position < 0 || $position >= strlen($content)) {
            return '';
        }

        $section = substr($content, $position);
        $lines = explode("\n", $section);

        // Determine the level of the heading at the start position
        $startLevel = 7; // default: capture everything
        $firstLine = ltrim($lines[0]);
        if (preg_match('/^(#{1,6})\s/', $firstLine, $m)) {
            $startLevel = strlen($m[1]);
        }

        // Find the end: next heading with same or higher level (lower number)
        $result = [$lines[0]];
        $inCodeBlock = false;
        for ($i = 1; $i < count($lines); $i++) {
            $trimmed = ltrim($lines[$i]);
            if (str_starts_with($trimmed, '```') || str_starts_with($trimmed, '~~~')) {
                $inCodeBlock = !$inCodeBlock;
            }
            if (!$inCodeBlock && preg_match('/^(#{1,6})\s/', $trimmed, $m)) {
                if (strlen($m[1]) <= $startLevel) {
                    break;
                }
            }
            $result[] = $lines[$i];
        }

        return implode("\n", $result);
    }

    /**
     * Read the session cookie value out of the request, ignoring obviously
     * malformed input. Empty string is valid (matches the X-Nook-User dev
     * bypass; the qjs handler verifies against the same empty value).
     */
    private function extractSessionId(Request $request): string
    {
        $cookieHeader = $request->header('Cookie');
        if ($cookieHeader === '') {
            return '';
        }
        $cookies = Cookies::parseCookieHeader($cookieHeader);
        $sid = trim($cookies[SessionStore::cookieName()] ?? '');
        return $sid !== '' && Uuid::isValid($sid) ? $sid : '';
    }

    /**
     * Build a session-bound HMAC URL the browser can hit directly for inline
     * embeds (img/video/audio src). 2hr TTL matches AttributeFilesController's
     * download URLs; relative URL keeps it cache-key compact.
     */
    private function signedInlineUrl(UrlSigner $signer, string $sessionId, NoteFileMetadataRow $file): string
    {
        $exp = time() + self::SIGNED_INLINE_TTL_SECONDS;
        $sig = $signer->sign(
            objectKey: $file->objectKey,
            exp: $exp,
            sessionId: $sessionId,
            filename: $file->filename,
            contentType: $file->mimeType,
            inline: true,
        );
        $query = http_build_query([
            'exp'    => (string)$exp,
            'sig'    => $sig,
            'fn'     => $file->filename,
            'ct'     => $file->mimeType,
            'inline' => '1',
        ], '', '&', PHP_QUERY_RFC3986);
        return '/files/' . ltrim($file->objectKey, '/') . '?' . $query;
    }

    private const SIGNED_INLINE_TTL_SECONDS = 7200; // 2h

    /**
     * Parses `type_ids` (CSV) preferentially, falling back to legacy `type_id`
     * (single UUID). Empty result means "no type filter". Throws 400 on a
     * malformed UUID anywhere in the list — partial validation isn't useful.
     *
     * @return list<string>
     */
    private static function parseTypeIdsParam(Request $request): array
    {
        $multi = trim($request->queryParam('type_ids'));
        if ($multi !== '') {
            $ids = [];
            foreach (explode(',', $multi) as $raw) {
                $tid = trim($raw);
                if ($tid === '') {
                    continue;
                }
                if (!Uuid::isValid($tid)) {
                    throw new HttpError('type_ids must be UUIDs', 400);
                }
                if (!in_array($tid, $ids, true)) {
                    $ids[] = $tid;
                }
            }
            return $ids;
        }
        $single = trim($request->queryParam('type_id'));
        if ($single === '') {
            return [];
        }
        if (!Uuid::isValid($single)) {
            throw new HttpError('type_id must be a UUID', 400);
        }
        return [$single];
    }
}
