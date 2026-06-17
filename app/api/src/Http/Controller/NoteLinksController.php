<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Dto\CreateNoteLinkRequest;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Throwable;
use Paith\Notes\Shared\Uuid;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\Auth\User;

final class NoteLinksController
{
    private const DEFAULT_RELATES_TO_KEY = 'relates_to';

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $direction = trim($request->queryParam('direction'));
        if ($direction === '') {
            $direction = 'both';
        }
        if (!in_array($direction, ['out', 'in', 'both'], true)) {
            throw new HttpError("direction must be one of out, in, both", 400);
        }

        $depth = (int)trim($request->queryParam('depth'));
        if ($depth <= 0) {
            $depth = 1;
        }
        if ($depth > 5) {
            $depth = 5;
        }

        $predicateIds = [];
        $predicateIdsRaw = trim($request->queryParam('predicate_ids'));
        if ($predicateIdsRaw !== '') {
            foreach (explode(',', $predicateIdsRaw) as $pid) {
                $pid = trim($pid);
                if (Uuid::isValid($pid)) {
                    $predicateIds[] = $pid;
                }
            }
        }

        // Optional filter: only surface links where source or target is one of these type IDs.
        // In strict mode, only expand the frontier through matching nodes and only include
        // links where both endpoints match (or are the starting note).
        // In non-strict mode (default), BFS traverses through all nodes but only surfaces
        // links where at least one endpoint matches.
        $nodeTypeIds = [];
        $nodeTypeIdsRaw = trim($request->queryParam('node_type_ids'));
        if ($nodeTypeIdsRaw !== '') {
            foreach (explode(',', $nodeTypeIdsRaw) as $tid) {
                $tid = trim($tid);
                if (Uuid::isValid($tid)) {
                    $nodeTypeIds[] = $tid;
                }
            }
        }
        $strictTypeFilter = trim($request->queryParam('strict_type_filter')) === '1';


        // Optional search term: only surface links where at least one connected note (excl. start)
        // matches by title or content (trigram-compatible LIKE). Traversal is unaffected.
        $q = strtolower(trim($request->queryParam('q')));
        $searchMode = strtolower(trim($request->queryParam('search_mode')));
        if (!in_array($searchMode, ['and', 'or'], true)) {
            $searchMode = 'and';
        }
        $search = \Paith\Notes\Shared\Search\SearchQueryParser::buildSearchClause(
            $q,
            $searchMode,
            'lower(title)',
            'lower(content)',
            '',
        );

        $noteCheck = $pdo->prepare('select 1 from global.notes where id = :id and nook_id = :nook_id');
        $noteCheck->execute([':id' => $noteId, ':nook_id' => $nookId]);
        if (!$noteCheck->fetchColumn()) {
            throw new HttpError('note not found', 404);
        }

        $linksById = [];
        $visited = [$noteId => true];
        $frontier = [$noteId => true];
        for ($i = 0; $i < $depth; $i++) {
            if ($frontier === []) {
                break;
            }

            $placeholders = [];
            $params = [':nook_id' => $nookId];
            $idx = 0;
            foreach (array_keys($frontier) as $id) {
                $idx++;
                $key = ':id' . $idx;
                $placeholders[] = $key;
                $params[$key] = $id;
            }
            $in = implode(', ', $placeholders);

            $where = '';
            if ($direction === 'out') {
                $where = 'and l.source_note_id in (' . $in . ')';
            } elseif ($direction === 'in') {
                $where = 'and l.target_note_id in (' . $in . ')';
            } else {
                $where = 'and (l.source_note_id in (' . $in . ') or l.target_note_id in (' . $in . '))';
            }

            $wherePredicates = '';
            if ($predicateIds !== []) {
                $pidPlaceholders = [];
                foreach ($predicateIds as $pi => $pid) {
                    $pkey = ':pid' . $pi;
                    $pidPlaceholders[] = $pkey;
                    $params[$pkey] = $pid;
                }
                $wherePredicates = 'and l.predicate_id in (' . implode(', ', $pidPlaceholders) . ')';
            }

            $stmt = $pdo->prepare(
                'select '
                . 'l.id, l.predicate_id, l.source_note_id, l.target_note_id, l.start_date, l.end_date, l.former, l.created_at, l.updated_at, '
                . 'p.key as predicate_key, p.forward_label, p.reverse_label, p.supports_start_date, p.supports_end_date, '
                . 'ns.title as source_note_title, ns.type_id as source_type_id, '
                . 'nt.title as target_note_title, nt.type_id as target_type_id, '
                . 'am.actor as last_actor, am.user_id as last_user_id, '
                . 'coalesce(nullif(lu.nickname, \'\'), concat(lu.first_name, \' \', lu.last_name)) as last_user_name '
                . 'from global.note_links l '
                . 'join global.link_predicates p on p.id = l.predicate_id '
                . 'join global.notes ns on ns.id = l.source_note_id '
                . 'join global.notes nt on nt.id = l.target_note_id '
                . 'left join global.audit_meta am on am.id = l.history_id '
                . 'left join global.users lu on lu.id = am.user_id '
                . 'where l.nook_id = :nook_id ' . $where . ' ' . $wherePredicates
            );
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $nextFrontier = [];
            foreach ($rows as $r) {
                if (!is_array($r)) {
                    continue;
                }

                $id = Row::str($r, 'id');
                if ($id === '') {
                    continue;
                }

                $sourceId     = Row::str($r, 'source_note_id');
                $targetId     = Row::str($r, 'target_note_id');
                $sourceTypeId = Row::str($r, 'source_type_id');
                $targetTypeId = Row::str($r, 'target_type_id');

                $sourceMatchesType = $nodeTypeIds === [] || in_array($sourceTypeId, $nodeTypeIds, true) || $sourceId === $noteId;
                $targetMatchesType = $nodeTypeIds === [] || in_array($targetTypeId, $nodeTypeIds, true) || $targetId === $noteId;

                // Expand frontier: in strict mode only through matching nodes, otherwise through all
                if ($strictTypeFilter && $nodeTypeIds !== []) {
                    if ($sourceId !== '' && Uuid::isValid($sourceId) && !isset($visited[$sourceId]) && $sourceMatchesType) {
                        $nextFrontier[$sourceId] = true;
                    }
                    if ($targetId !== '' && Uuid::isValid($targetId) && !isset($visited[$targetId]) && $targetMatchesType) {
                        $nextFrontier[$targetId] = true;
                    }
                } else {
                    if ($sourceId !== '' && Uuid::isValid($sourceId) && !isset($visited[$sourceId])) {
                        $nextFrontier[$sourceId] = true;
                    }
                    if ($targetId !== '' && Uuid::isValid($targetId) && !isset($visited[$targetId])) {
                        $nextFrontier[$targetId] = true;
                    }
                }

                // Skip already-seen links
                if (isset($linksById[$id])) {
                    continue;
                }

                // Apply node type filter:
                // Strict: both endpoints must match (or be the center note)
                // Non-strict: at least one endpoint must match
                if ($nodeTypeIds !== []) {
                    if ($strictTypeFilter) {
                        if (!$sourceMatchesType || !$targetMatchesType) {
                            continue;
                        }
                    } else {
                        if (!$sourceMatchesType && !$targetMatchesType) {
                            continue;
                        }
                    }
                }


                $former = Row::decodeJsonObject($r['former'] ?? null);
                $lastUserName = is_scalar($r['last_user_name'] ?? null) ? trim((string)$r['last_user_name']) : '';

                $linksById[$id] = [
                    'id' => $id,
                    'nook_id' => $nookId,
                    'predicate_id' => Row::str($r, 'predicate_id'),
                    'predicate_key' => Row::str($r, 'predicate_key'),
                    'forward_label' => Row::str($r, 'forward_label'),
                    'reverse_label' => Row::str($r, 'reverse_label'),
                    'supports_start_date' => (bool)($r['supports_start_date'] ?? false),
                    'supports_end_date' => (bool)($r['supports_end_date'] ?? false),
                    'source_note_id' => $sourceId,
                    'source_note_title' => Row::str($r, 'source_note_title'),
                    'source_type_id' => $sourceTypeId,
                    'target_note_id' => $targetId,
                    'target_note_title' => Row::str($r, 'target_note_title'),
                    'target_type_id' => $targetTypeId,
                    'start_date' => Row::str($r, 'start_date'),
                    'end_date' => Row::str($r, 'end_date'),
                    'former' => $former === [] ? (object)[] : $former,
                    'last_actor' => Row::str($r, 'last_actor', 'user'),
                    'last_user_name' => $lastUserName,
                    'created_at' => Row::str($r, 'created_at'),
                    'updated_at' => Row::str($r, 'updated_at'),
                ];
            }

            foreach ($nextFrontier as $nid => $_) {
                $visited[$nid] = true;
            }
            $frontier = $nextFrontier;
        }

        // Post-BFS search filter: keep only links where at least one endpoint (excluding the
        // starting note) matches the query by title or content.
        if ($q !== '' && $linksById !== []) {
            $noteIdSet = [];
            foreach ($linksById as $link) {
                if ($link['source_note_id'] !== $noteId) {
                    $noteIdSet[$link['source_note_id']] = true;
                }
                if ($link['target_note_id'] !== $noteId) {
                    $noteIdSet[$link['target_note_id']] = true;
                }
            }

            $matchingIds = [];
            if ($noteIdSet !== []) {
                $placeholders = [];
                $qParams = [];
                foreach (array_keys($noteIdSet) as $i => $id) {
                    $key = ':nid' . $i;
                    $placeholders[] = $key;
                    $qParams[$key] = $id;
                }
                $in = implode(', ', $placeholders);

                $searchWhere = $search['where'] !== '' ? $search['where'] : 'true';
                foreach ($search['bindings'] as $bp => $bv) {
                    $qParams[$bp] = $bv;
                }

                $matchStmt = $pdo->prepare(
                    "select id from global.notes where id in ($in) and $searchWhere"
                );
                $matchStmt->execute($qParams);
                foreach ($matchStmt->fetchAll(PDO::FETCH_COLUMN) as $mid) {
                    $midStr = is_scalar($mid) ? (string)$mid : '';
                    if ($midStr !== '') {
                        $matchingIds[$midStr] = true;
                    }
                }
            }

            foreach (array_keys($linksById) as $linkId) {
                $link = $linksById[$linkId];
                $srcMatch = $link['source_note_id'] !== $noteId && isset($matchingIds[$link['source_note_id']]);
                $tgtMatch = $link['target_note_id'] !== $noteId && isset($matchingIds[$link['target_note_id']]);
                if (!$srcMatch && !$tgtMatch) {
                    unset($linksById[$linkId]);
                }
            }
        }

        // Non-strict type filter post-processing: prune non-matching leaf nodes.
        // A non-matching node is kept only if it directly connects to 2+ matching nodes
        // (i.e. it bridges between matching nodes). Repeat until stable.
        if (!$strictTypeFilter && $nodeTypeIds !== [] && $linksById !== []) {
            $matchingNodes = [$noteId => true]; // center always matches
            foreach ($linksById as $link) {
                if (in_array($link['source_type_id'], $nodeTypeIds, true)) {
                    $matchingNodes[$link['source_note_id']] = true;
                }
                if (in_array($link['target_type_id'], $nodeTypeIds, true)) {
                    $matchingNodes[$link['target_note_id']] = true;
                }
            }

            $changed = true;
            while ($changed) {
                $changed = false;
                // Count matching neighbors for each non-matching node
                $matchingNeighborCount = [];
                foreach ($linksById as $link) {
                    $src = $link['source_note_id'];
                    $tgt = $link['target_note_id'];
                    if (!isset($matchingNodes[$src])) {
                        if (isset($matchingNodes[$tgt])) {
                            $matchingNeighborCount[$src] = ($matchingNeighborCount[$src] ?? 0) + 1;
                        }
                    }
                    if (!isset($matchingNodes[$tgt])) {
                        if (isset($matchingNodes[$src])) {
                            $matchingNeighborCount[$tgt] = ($matchingNeighborCount[$tgt] ?? 0) + 1;
                        }
                    }
                }

                // Remove links involving non-matching nodes with < 2 matching neighbors
                $removeNodes = [];
                foreach ($matchingNeighborCount as $nodeId2 => $count) {
                    if ($count < 2) {
                        $removeNodes[$nodeId2] = true;
                    }
                }
                // Also remove non-matching nodes with 0 matching neighbors (not in count at all)
                foreach ($linksById as $link) {
                    foreach ([$link['source_note_id'], $link['target_note_id']] as $nid) {
                        if (!isset($matchingNodes[$nid]) && !isset($matchingNeighborCount[$nid])) {
                            $removeNodes[$nid] = true;
                        }
                    }
                }

                if ($removeNodes !== []) {
                    foreach (array_keys($linksById) as $linkId) {
                        $link = $linksById[$linkId];
                        if (isset($removeNodes[$link['source_note_id']]) || isset($removeNodes[$link['target_note_id']])) {
                            unset($linksById[$linkId]);
                            $changed = true;
                        }
                    }
                }
            }
        }

        return JsonResponse::ok(['links' => array_values($linksById)]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $sourceNoteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $payload = CreateNoteLinkRequest::fromJson($request->jsonBody());

        if ($payload->targetNoteId === $sourceNoteId) {
            throw new HttpError('cannot link a note to itself', 400);
        }

        $predStmt = $pdo->prepare(
            'select key, forward_label, reverse_label, supports_start_date, supports_end_date '
            . 'from global.link_predicates where id = :id and nook_id = :nook_id'
        );
        $predStmt->execute([':id' => $payload->predicateId, ':nook_id' => $nookId]);
        $pred = $predStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($pred)) {
            throw new HttpError('predicate not found', 404);
        }

        $supportsStart = (bool)($pred['supports_start_date'] ?? false);
        $supportsEnd = (bool)($pred['supports_end_date'] ?? false);

        if ($payload->startDate !== null && !$supportsStart) {
            throw new HttpError('predicate does not support start_date', 400);
        }
        if ($payload->endDate !== null && !$supportsEnd) {
            throw new HttpError('predicate does not support end_date', 400);
        }

        $sourceStmt = $pdo->prepare('select id, type_id from global.notes where id = :id and nook_id = :nook_id');
        $sourceStmt->execute([':id' => $sourceNoteId, ':nook_id' => $nookId]);
        $source = $sourceStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($source)) {
            throw new HttpError('source note not found', 404);
        }

        $targetStmt = $pdo->prepare('select id, type_id from global.notes where id = :id and nook_id = :nook_id');
        $targetStmt->execute([':id' => $payload->targetNoteId, ':nook_id' => $nookId]);
        $target = $targetStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($target)) {
            throw new HttpError('target note not found', 404);
        }

        $sourceTypeId = is_scalar($source['type_id'] ?? null) ? trim((string)$source['type_id']) : '';
        $targetTypeId = is_scalar($target['type_id'] ?? null) ? trim((string)$target['type_id']) : '';

        if (!$this->isPredicateAllowedForTypes($pdo, $nookId, $payload->predicateId, $sourceTypeId, $targetTypeId)) {
            throw new HttpError('predicate not allowed for these note types', 400);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'insert into global.note_links (nook_id, predicate_id, source_note_id, target_note_id, start_date, end_date) '
                . 'values (:nook_id, :predicate_id, :source_note_id, :target_note_id, :start_date, :end_date) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':predicate_id' => $payload->predicateId,
                ':source_note_id' => $sourceNoteId,
                ':target_note_id' => $payload->targetNoteId,
                ':start_date' => $payload->startDate,
                ':end_date' => $payload->endDate,
            ]);

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create link', 500);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'link' => [
                    'id' => Row::str($row, 'id'),
                    'nook_id' => $nookId,
                    'predicate_id' => $payload->predicateId,
                    'predicate_key' => Row::str($pred, 'key'),
                    'forward_label' => Row::str($pred, 'forward_label'),
                    'reverse_label' => Row::str($pred, 'reverse_label'),
                    'supports_start_date' => $supportsStart,
                    'supports_end_date' => $supportsEnd,
                    'source_note_id' => $sourceNoteId,
                    'target_note_id' => $payload->targetNoteId,
                    'start_date' => $payload->startDate ?? '',
                    'end_date' => $payload->endDate ?? '',
                    'former' => (object)[],
                    'created_at' => Row::str($row, 'created_at'),
                    'updated_at' => Row::str($row, 'updated_at'),
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

        $linkId = $request->requireUuidRouteParam('linkId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'delete from global.note_links '
            . 'where id = :id and nook_id = :nook_id and (source_note_id = :note_id or target_note_id = :note_id) '
            . 'returning id'
        );
        $stmt->execute([':id' => $linkId, ':nook_id' => $nookId, ':note_id' => $noteId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('link not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'link_id' => $linkId,
        ]);
    }

    private function isPredicateAllowedForTypes(PDO $pdo, string $nookId, string $predicateId, string $sourceTypeId, string $targetTypeId): bool
    {
        $stmt = $pdo->prepare(
            'select source_type_id, target_type_id, include_source_subtypes, include_target_subtypes '
            . 'from global.link_predicate_rules where predicate_id = :predicate_id'
        );
        $stmt->execute([':predicate_id' => $predicateId]);
        $rules = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($rules === []) {
            return true;
        }

        foreach ($rules as $r) {
            if (!is_array($r)) {
                continue;
            }

            $ruleSource = is_scalar($r['source_type_id'] ?? null) ? trim((string)$r['source_type_id']) : '';
            $ruleTarget = is_scalar($r['target_type_id'] ?? null) ? trim((string)$r['target_type_id']) : '';
            $incSource = (bool)($r['include_source_subtypes'] ?? true);
            $incTarget = (bool)($r['include_target_subtypes'] ?? true);

            $sourceOk = $this->typeMatchesRule($pdo, $nookId, $sourceTypeId, $ruleSource, $incSource);
            if (!$sourceOk) {
                continue;
            }

            $targetOk = $this->typeMatchesRule($pdo, $nookId, $targetTypeId, $ruleTarget, $incTarget);
            if (!$targetOk) {
                continue;
            }

            return true;
        }

        return false;
    }

    private function typeMatchesRule(PDO $pdo, string $nookId, string $noteTypeId, string $ruleTypeId, bool $includeSubtypes): bool
    {
        if ($ruleTypeId === '') {
            return true;
        }

        if ($noteTypeId === '') {
            return false;
        }

        if (!$includeSubtypes) {
            return $noteTypeId === $ruleTypeId;
        }

        foreach ($this->ancestorTypeIds($pdo, $nookId, $noteTypeId) as $ancestorId) {
            if ($ancestorId === $ruleTypeId) {
                return true;
            }
        }

        return false;
    }

    /** @return array<int, string> */
    private function ancestorTypeIds(PDO $pdo, string $nookId, string $typeId): array
    {
        $seen = [];
        $out = [];

        $current = $typeId;
        while ($current !== '' && !isset($seen[$current])) {
            $seen[$current] = true;
            $out[] = $current;

            $stmt = $pdo->prepare('select parent_id from global.note_types where id = :id and nook_id = :nook_id');
            $stmt->execute([':id' => $current, ':nook_id' => $nookId]);
            $parentRaw = $stmt->fetchColumn();
            $parent = is_scalar($parentRaw) ? trim((string)$parentRaw) : '';

            if ($parent === '' || !Uuid::isValid($parent)) {
                break;
            }

            $current = $parent;
        }

        return $out;
    }

    private function ensureDefaultRelatesTo(PDO $pdo, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_RELATES_TO_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.link_predicates (nook_id, key, forward_label, reverse_label, supports_start_date, supports_end_date) '
            . 'values (:nook_id, :key, :forward_label, :reverse_label, false, false)'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_RELATES_TO_KEY,
            ':forward_label' => 'relates to',
            ':reverse_label' => 'related to',
        ]);
    }
}
