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
use Throwable;

final class NoteTypesController
{
    private const DEFAULT_BASE_TYPE_KEY = 'base';
    private const DEFAULT_FILE_TYPE_KEY = 'file';
    private const DEFAULT_GRAPH_TYPE_KEY = 'graph';
    private const DEFAULT_VIEW_TYPE_KEY = 'view';
    private const TYPE_ID_ALL = 'all';

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $baseTypeId = $this->ensureDefaultBaseType($pdo, $nookId);
        $this->ensureDefaultFileType($pdo, $nookId, $baseTypeId);
        $this->ensureDefaultGraphType($pdo, $nookId, $baseTypeId);
        $this->ensureDefaultViewType($pdo, $nookId, $baseTypeId);

        $stmt = $pdo->prepare(
            'select id, key, label, description, parent_id, attribute_order, created_at, updated_at '
            . 'from global.note_types where nook_id = :nook_id order by label asc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $types = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $types[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'key' => is_scalar($r['key'] ?? null) ? (string)$r['key'] : '',
                'label' => is_scalar($r['label'] ?? null) ? (string)$r['label'] : '',
                'description' => is_scalar($r['description'] ?? null) ? (string)$r['description'] : '',
                'parent_id' => is_scalar($r['parent_id'] ?? null) ? (string)$r['parent_id'] : '',
                'attribute_order' => self::decodeJsonArray($r['attribute_order'] ?? null),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
                'attributes' => [],
            ];
        }

        // Bulk-load own attributes per type (frontend resolves inheritance via parent_id)
        $attrStmt = $pdo->prepare(
            'select id, type_id, name, kind, config, indexed, created_at, updated_at '
            . 'from global.type_attributes where nook_id = :nook_id order by name asc'
        );
        $attrStmt->execute([':nook_id' => $nookId]);
        $attrRows = $attrStmt->fetchAll(PDO::FETCH_ASSOC);

        $attrsByType = [];
        foreach ($attrRows as $a) {
            if (!is_array($a)) continue;
            $tid = is_scalar($a['type_id'] ?? null) ? (string)$a['type_id'] : '';
            $config = self::decodeJsonObject($a['config'] ?? null);
            $attrsByType[$tid][] = [
                'id' => is_scalar($a['id'] ?? null) ? (string)$a['id'] : '',
                'type_id' => $tid,
                'name' => is_scalar($a['name'] ?? null) ? (string)$a['name'] : '',
                'kind' => is_scalar($a['kind'] ?? null) ? (string)$a['kind'] : '',
                'config' => $config === [] ? (object)[] : $config,
                'indexed' => (bool)($a['indexed'] ?? false),
                'created_at' => is_scalar($a['created_at'] ?? null) ? (string)$a['created_at'] : '',
                'updated_at' => is_scalar($a['updated_at'] ?? null) ? (string)$a['updated_at'] : '',
            ];
        }

        foreach ($types as &$t) {
            $t['attributes'] = $attrsByType[$t['id']] ?? [];
        }
        unset($t);

        // Types version: max audit_meta id for type-related changes in this nook.
        // Used by frontend to skip redundant reloads when WS event carries
        // the same version it already has.
        $versionStmt = $pdo->prepare(
            "select coalesce(max(id), 0) from global.audit_meta "
            . "where nook_id = :nook_id and table_name in ('note_types', 'type_attributes')"
        );
        $versionStmt->execute([':nook_id' => $nookId]);
        $typesVersion = (int)$versionStmt->fetchColumn();

        return JsonResponse::ok(['types' => $types, 'version' => $typesVersion]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $keyRaw = $data['key'] ?? '';
        $key = is_string($keyRaw) ? trim($keyRaw) : '';
        if ($key === '') {
            throw new HttpError('key is required', 400);
        }

        $labelRaw = $data['label'] ?? '';
        $label = is_string($labelRaw) ? trim($labelRaw) : '';
        if ($label === '') {
            throw new HttpError('label is required', 400);
        }

        $descriptionRaw = $data['description'] ?? '';
        $description = is_string($descriptionRaw) ? $descriptionRaw : '';

        $parentIdRaw = $data['parent_id'] ?? '';
        $parentId = is_string($parentIdRaw) ? trim($parentIdRaw) : '';
        if ($parentId !== '' && !self::isUuid($parentId)) {
            throw new HttpError('parent_id must be a UUID', 400);
        }

        if ($parentId !== '') {
            $p = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $p->execute([':id' => $parentId, ':nook_id' => $nookId]);
            if (!$p->fetchColumn()) {
                throw new HttpError('parent not found', 404);
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'insert into global.note_types (nook_id, key, label, description, parent_id) '
                . 'values (:nook_id, :key, :label, :description, :parent_id) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':key', $key);
            $stmt->bindValue(':label', $label);
            $stmt->bindValue(':description', $description);
            $stmt->bindValue(':parent_id', $parentId !== '' ? $parentId : null);
            $stmt->execute();

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create type', 500);
            }

            $pdo->commit();

            $id = is_scalar($row['id'] ?? null) ? (string)$row['id'] : '';

            return JsonResponse::ok([
                'type' => [
                    'id' => $id,
                    'nook_id' => $nookId,
                    'key' => $key,
                    'label' => $label,
                    'description' => $description,
                    'parent_id' => $parentId,
                    'attribute_order' => [],
                    'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                    'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $typeId = trim($request->routeParam('typeId'));
        if ($typeId === '') {
            throw new HttpError('typeId is required', 400);
        }
        if (!self::isUuid($typeId)) {
            throw new HttpError('typeId must be a UUID', 400);
        }

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $keyCheck = $pdo->prepare('select key from global.note_types where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('type not found', 404);
        }
        $data = $request->jsonBody();

        $keyRaw = $data['key'] ?? '';
        $key = is_string($keyRaw) ? trim($keyRaw) : '';
        if ($key === '') {
            throw new HttpError('key is required', 400);
        }

        $labelRaw = $data['label'] ?? '';
        $label = is_string($labelRaw) ? trim($labelRaw) : '';
        if ($label === '') {
            throw new HttpError('label is required', 400);
        }

        $descriptionRaw = $data['description'] ?? '';
        $description = is_string($descriptionRaw) ? $descriptionRaw : '';

        $parentIdRaw = $data['parent_id'] ?? '';
        $parentId = is_string($parentIdRaw) ? trim($parentIdRaw) : '';
        if ($parentId !== '' && !self::isUuid($parentId)) {
            throw new HttpError('parent_id must be a UUID', 400);
        }
        if ($parentId === $typeId) {
            throw new HttpError('parent_id cannot be self', 400);
        }

        if ($parentId !== '') {
            $p = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $p->execute([':id' => $parentId, ':nook_id' => $nookId]);
            if (!$p->fetchColumn()) {
                throw new HttpError('parent not found', 404);
            }
        }

        $attributeOrderRaw = $data['attribute_order'] ?? null;
        $attributeOrder = is_array($attributeOrderRaw) ? array_values(array_filter($attributeOrderRaw, 'is_string')) : null;

        if ($key !== $existingKey) {
            $dupe = $pdo->prepare('select 1 from global.note_types where nook_id = :nook_id and key = :key and id != :id');
            $dupe->execute([':nook_id' => $nookId, ':key' => $key, ':id' => $typeId]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }
        }

        $sql = 'update global.note_types set key = :key, label = :label, description = :description, parent_id = :parent_id';
        if ($attributeOrder !== null) {
            $sql .= ', attribute_order = :attribute_order::jsonb';
        }
        $sql .= ', updated_at = now() where id = :id and nook_id = :nook_id returning description, attribute_order, created_at, updated_at';

        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':key', $key);
        $stmt->bindValue(':label', $label);
        $stmt->bindValue(':description', $description);
        $stmt->bindValue(':parent_id', $parentId !== '' ? $parentId : null);
        if ($attributeOrder !== null) {
            $stmt->bindValue(':attribute_order', json_encode($attributeOrder));
        }
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('type not found', 404);
        }

        return JsonResponse::ok([
            'type' => [
                'id' => $typeId,
                'nook_id' => $nookId,
                'key' => $key,
                'label' => $label,
                'description' => is_scalar($row['description'] ?? null) ? (string)$row['description'] : $description,
                'parent_id' => $parentId,
                'attribute_order' => self::decodeJsonArray($row['attribute_order'] ?? null),
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
            ],
        ]);
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $typeId = trim($request->routeParam('typeId'));
        if ($typeId === '') {
            throw new HttpError('typeId is required', 400);
        }
        if (!self::isUuid($typeId)) {
            throw new HttpError('typeId must be a UUID', 400);
        }

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
        $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        if (!$typeCheck->fetchColumn()) {
            throw new HttpError('type not found', 404);
        }

        // Prevent deletion if type has children
        $childCheck = $pdo->prepare('select 1 from global.note_types where parent_id = :id and nook_id = :nook_id limit 1');
        $childCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        if ($childCheck->fetchColumn()) {
            throw new HttpError('cannot delete type that has child types — delete or reparent children first', 400);
        }

        // Unset type_id on notes (attributes stay as inert JSONB)
        $pdo->prepare('update global.notes set type_id = null where type_id = :type_id and nook_id = :nook_id')
            ->execute([':type_id' => $typeId, ':nook_id' => $nookId]);

        $stmt = $pdo->prepare('delete from global.note_types where id = :id and nook_id = :nook_id returning id');
        $stmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('type not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'type_id' => $typeId,
        ]);
    }

    public function notes(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $typeId = trim($request->routeParam('typeId'));
        if ($typeId === '') {
            throw new HttpError('typeId is required', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $v = strtolower(trim($request->queryParam('include_subtypes')));
        $includeSubtypes = in_array($v, ['1', 'true', 'yes', 'on'], true);

        $limit = (int)trim($request->queryParam('limit'));
        if ($limit === 0) {
            $limit = 50;
        }
        if ($limit <= 0) {
            $limit = 50;
        }
        if ($limit > 200) {
            $limit = 200;
        }

        $cursor = trim($request->queryParam('cursor'));
        $cursorCreatedAt = '';
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
            // Support both legacy {created_at, id} and current {created_at (sort_val), id}
            $cursorCreatedAtRaw = $obj['created_at'] ?? '';
            $cursorIdRaw = $obj['id'] ?? '';
            $cursorCreatedAt = is_string($cursorCreatedAtRaw) ? trim($cursorCreatedAtRaw) : '';
            $cursorId = is_string($cursorIdRaw) ? trim($cursorIdRaw) : '';
            if ($cursorCreatedAt === '' || $cursorId === '' || !self::isUuid($cursorId)) {
                throw new HttpError('cursor is invalid', 400);
            }
        }

        $isAll = $typeId === self::TYPE_ID_ALL;
        if (!$isAll && !self::isUuid($typeId)) {
            throw new HttpError('typeId must be a UUID or "all"', 400);
        }

        if (!$isAll) {
            $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            if (!$typeCheck->fetchColumn()) {
                throw new HttpError('type not found', 404);
            }
        }

        // Sort param: newest (default), oldest, updated_newest, updated_oldest
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

        $search = \Paith\Notes\Shared\Search\SearchQueryParser::buildSearchClause($q, $searchMode);
        $whereSearch = $search['where'];
        // Boost search rank with total views (logarithmic to avoid popular notes dominating)
        $searchRank = $search['rank'] !== '0'
            ? '(' . $search['rank'] . ' + ln(1 + least(coalesce(ns.view_count, 0), 1000)) * 0.5)'
            : '0';
        $searchBindings = $search['bindings'];

        $orderByWithRank = $searchRank !== '0'
            ? "order by search_rank desc, n.{$sortCol} {$sortDir}, n.id {$sortDir}"
            : $orderBy;

        $whereKind = '';

        // Attribute filters: JSON array of {attribute_id, op, value}
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

        $selectCols = "select n.id, n.title, n.type_id, n.attributes, n.created_at, n.updated_at,
                    coalesce(ns.outgoing_mentions, 0) as outgoing_mentions_count,
                    coalesce(ns.incoming_mentions, 0) as incoming_mentions_count,
                    coalesce(ns.outgoing_links, 0) as outgoing_links_count,
                    coalesce(ns.incoming_links, 0) as incoming_links_count,
                    {$searchRank} as search_rank";
        $joinCounts = '
                left join global.note_stats ns on ns.note_id = n.id';

        if ($isAll) {
            $stmt = $pdo->prepare(
                $selectCols . '
                from global.notes n'
                . $joinCounts . '
                where n.nook_id = :nook_id ' . $whereCursor . '
                ' . $whereSearch . '
                ' . $whereKind . '
                ' . $whereAttrFilter . '
                ' . $whereUnlinked . '
                ' . $orderByWithRank . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            foreach ($searchBindings as $param => $val) {
                $stmt->bindValue($param, $val);
            }
            if ($cursor !== '') {
                $stmt->bindValue(':cursor_sort_val', $cursorCreatedAt);
                $stmt->bindValue(':cursor_id', $cursorId);
            }
            $stmt->execute();
        } elseif ($includeSubtypes) {
            $stmt = $pdo->prepare(
                'with recursive type_tree as (
                    select id from global.note_types where id = :type_id and nook_id = :nook_id
                    union all
                    select nt.id
                    from global.note_types nt
                    join type_tree tt on nt.parent_id = tt.id
                    where nt.nook_id = :nook_id
                )
                ' . $selectCols . '
                from global.notes n'
                . $joinCounts . '
                where n.nook_id = :nook_id and n.type_id in (select id from type_tree)
                ' . $whereCursor . '
                ' . $whereSearch . '
                ' . $whereKind . '
                ' . $whereAttrFilter . '
                ' . $whereUnlinked . '
                ' . $orderByWithRank . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            foreach ($searchBindings as $param => $val) {
                $stmt->bindValue($param, $val);
            }
            if ($cursor !== '') {
                $stmt->bindValue(':cursor_sort_val', $cursorCreatedAt);
                $stmt->bindValue(':cursor_id', $cursorId);
            }
            $stmt->execute();
        } else {
            $stmt = $pdo->prepare(
                $selectCols . '
                from global.notes n'
                . $joinCounts . '
                where n.nook_id = :nook_id and n.type_id = :type_id ' . $whereCursor . '
                ' . $whereSearch . '
                ' . $whereKind . '
                ' . $whereAttrFilter . '
                ' . $whereUnlinked . '
                ' . $orderByWithRank . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            foreach ($searchBindings as $param => $val) {
                $stmt->bindValue($param, $val);
            }
            if ($cursor !== '') {
                $stmt->bindValue(':cursor_sort_val', $cursorCreatedAt);
                $stmt->bindValue(':cursor_id', $cursorId);
            }
            $stmt->execute();
        }

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        $nextCursor = '';
        $count = count($rows);
        $hasMore = $count > $limit;
        if ($hasMore) {
            $rows = array_slice($rows, 0, $limit);
        }

        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $notes[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'title' => is_scalar($r['title'] ?? null) ? (string)$r['title'] : '',
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
                'attributes' => self::decodeJsonObject($r['attributes'] ?? null),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
                'outgoing_mentions_count' => is_scalar($r['outgoing_mentions_count'] ?? null) ? (int)$r['outgoing_mentions_count'] : 0,
                'incoming_mentions_count' => is_scalar($r['incoming_mentions_count'] ?? null) ? (int)$r['incoming_mentions_count'] : 0,
                'outgoing_links_count' => is_scalar($r['outgoing_links_count'] ?? null) ? (int)$r['outgoing_links_count'] : 0,
                'incoming_links_count' => is_scalar($r['incoming_links_count'] ?? null) ? (int)$r['incoming_links_count'] : 0,
            ];
        }

        if ($hasMore && $rows !== []) {
            $last = $rows[count($rows) - 1];
            if (is_array($last)) {
                $lastSortVal = is_scalar($last[$sortCol] ?? null) ? (string)$last[$sortCol] : '';
                $lastId = is_scalar($last['id'] ?? null) ? (string)$last['id'] : '';
                if ($lastSortVal !== '' && $lastId !== '' && self::isUuid($lastId)) {
                    $payload = json_encode(['created_at' => $lastSortVal, 'id' => $lastId]);
                    if (is_string($payload)) {
                        $nextCursor = base64_encode($payload);
                    }
                }
            }
        }

        // Search headings when there's a query (separate result set)
        $headingMatches = [];
        if ($q !== '' && $cursor === '') {
            $headingTerms = \Paith\Notes\Shared\Search\SearchQueryParser::splitTerms($q);
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
                    if (!is_array($hr)) continue;
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

    private function requireMember(PDO $pdo, array $user, string $nookId): array
    {
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $check = $pdo->prepare('select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([
            ':nook_id' => $nookId,
            ':user_id' => $userId,
        ]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('forbidden', 403);
        }
        return $row;
    }

    /**
     * Ensure the base type exists. All other types inherit from it.
     * Returns the base type ID.
     */
    private function ensureDefaultBaseType(PDO $pdo, string $nookId): string
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_BASE_TYPE_KEY]);
        $existing = $check->fetchColumn();
        if ($existing) {
            return (string)$existing;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, description) '
            . 'values (:nook_id, :key, :label, :description) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_BASE_TYPE_KEY,
            ':label' => 'Note',
            ':description' => 'Base type — all other types inherit its attributes',
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            // Seed "References" — outgoing links and mentions
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'References', 'linked_notes', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode([
                    'direction' => 'outgoing',
                    'include_mentions' => true,
                    'display' => 'list',
                ]),
            ]);

            // Seed "Referenced By" — incoming links and mentions
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'Referenced By', 'linked_notes', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode([
                    'direction' => 'incoming',
                    'include_mentions' => true,
                    'display' => 'list',
                ]),
            ]);

            // Seed "Content" — note body rendering
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'Content', 'content', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode(['mode' => 'markdown']),
            ]);

            // Seed "Info" — note metadata
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'Info', 'metadata', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode([
                    'show_version' => true,
                    'show_created' => true,
                    'show_updated' => true,
                    'show_views' => true,
                ]),
            ]);

            // Seed "Table of Contents"
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'Table of Contents', 'toc', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode(['max_depth' => 3]),
            ]);

            // Seed "History" — recent changes
            $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'History', 'history', :config::jsonb) "
                . "on conflict do nothing"
            )->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':config' => json_encode(['limit' => 5]),
            ]);
        }

        return $typeId;
    }

    private function ensureDefaultFileType(PDO $pdo, string $nookId, string $baseTypeId): void
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_FILE_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id) '
            . 'values (:nook_id, :key, :label, :parent_id) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_FILE_TYPE_KEY,
            ':label' => 'File',
            ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $attrStmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'File', 'file', '{\"display\": \"preview\"}'::jsonb) "
                . "on conflict do nothing"
            );
            $attrStmt->execute([':nook_id' => $nookId, ':type_id' => $typeId]);
        }
    }

    private function ensureDefaultGraphType(PDO $pdo, string $nookId, string $baseTypeId): void
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_GRAPH_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id) '
            . 'values (:nook_id, :key, :label, :parent_id) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_GRAPH_TYPE_KEY,
            ':label' => 'Graph View',
            ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $attrStmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'Graph', 'graph', '{}'::jsonb) "
                . "on conflict do nothing"
            );
            $attrStmt->execute([':nook_id' => $nookId, ':type_id' => $typeId]);
        }
    }

    /**
     * Parse attribute_filters JSON and build WHERE clauses.
     * @param array<string, string> &$bindings Merged into the caller's bindings
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
            if (!is_array($f)) continue;
            $attrId = trim((string)($f['attribute_id'] ?? ''));
            $op = strtolower(trim((string)($f['op'] ?? '')));
            $value = $f['value'] ?? null;

            if ($attrId === '' || !self::isUuid($attrId)) continue;

            $paramKey = ':af_' . $idx;
            $jsonPath = "n.attributes->>'" . $attrId . "'";
            $jsonPathObj = "n.attributes->'" . $attrId . "'";
            $idx++;

            switch ($op) {
                case 'eq':
                    $clauses[] = "{$jsonPath} = {$paramKey}";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'neq':
                    $clauses[] = "({$jsonPath} IS NULL OR {$jsonPath} != {$paramKey})";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'gt':
                    $clauses[] = "global.safe_numeric({$jsonPath}) > {$paramKey}::numeric";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'gte':
                    $clauses[] = "global.safe_numeric({$jsonPath}) >= {$paramKey}::numeric";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'lt':
                    $clauses[] = "global.safe_numeric({$jsonPath}) < {$paramKey}::numeric";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'lte':
                    $clauses[] = "global.safe_numeric({$jsonPath}) <= {$paramKey}::numeric";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'date_gt':
                    $clauses[] = "({$jsonPath})::date > {$paramKey}::date";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'date_gte':
                    $clauses[] = "({$jsonPath})::date >= {$paramKey}::date";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'date_lt':
                    $clauses[] = "({$jsonPath})::date < {$paramKey}::date";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'date_lte':
                    $clauses[] = "({$jsonPath})::date <= {$paramKey}::date";
                    $bindings[$paramKey] = (string)$value;
                    break;
                case 'contains':
                    $clauses[] = "{$jsonPath} ILIKE {$paramKey}";
                    $bindings[$paramKey] = '%' . str_replace(['%', '_'], ['\\%', '\\_'], (string)$value) . '%';
                    break;
                case 'starts_with':
                    $clauses[] = "{$jsonPath} ILIKE {$paramKey}";
                    $bindings[$paramKey] = str_replace(['%', '_'], ['\\%', '\\_'], (string)$value) . '%';
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
                            $bindings[$pk] = (string)$vv;
                        }
                        $clauses[] = "{$jsonPath} IN (" . implode(', ', $inPlaceholders) . ")";
                    }
                    break;
                case 'overlaps':
                    // value should be {from: "...", to: "..."}
                    if (is_array($value)) {
                        $from = (string)($value['from'] ?? '');
                        $to = (string)($value['to'] ?? '');
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

    /** @return array<string, mixed> */
    private static function decodeJsonObject(mixed $value): array
    {
        if (!is_scalar($value)) return [];
        $decoded = json_decode((string)$value, true);
        return is_array($decoded) ? $decoded : [];
    }

    /** @return list<string> */
    private static function decodeJsonArray(mixed $value): array
    {
        if (!is_scalar($value)) {
            return [];
        }
        $decoded = json_decode((string)$value, true);
        if (!is_array($decoded)) {
            return [];
        }
        return array_values(array_filter($decoded, 'is_string'));
    }

    private function ensureDefaultViewType(PDO $pdo, string $nookId, string $baseTypeId): void
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_VIEW_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id) '
            . 'values (:nook_id, :key, :label, :parent_id) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_VIEW_TYPE_KEY,
            ':label' => 'View',
            ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $attrStmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'View', 'view', '{}'::jsonb) "
                . "on conflict do nothing"
            );
            $attrStmt->execute([':nook_id' => $nookId, ':type_id' => $typeId]);
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
