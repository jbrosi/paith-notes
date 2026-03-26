<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use Throwable;

final class NoteTypesController
{
    private const ROOT_FILE_TYPE_KEY = 'file';
    private const AI_MEMORY_TYPE_KEY = 'ai-memory';
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

        $this->ensureRootFileType($pdo, $nookId);
        $this->ensureAiMemoryType($pdo, $nookId);

        $stmt = $pdo->prepare(
            'select id, key, label, description, parent_id, applies_to_files, applies_to_notes, created_at, updated_at '
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
                'applies_to_files' => (bool)($r['applies_to_files'] ?? true),
                'applies_to_notes' => (bool)($r['applies_to_notes'] ?? true),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
            ];
        }

        return JsonResponse::ok(['types' => $types]);
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

        $this->requireMember($pdo, $user, $nookId);

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

        $appliesToFiles = (bool)($data['applies_to_files'] ?? true);
        $appliesToNotes = (bool)($data['applies_to_notes'] ?? true);

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
                'insert into global.note_types (nook_id, key, label, description, parent_id, applies_to_files, applies_to_notes) '
                . 'values (:nook_id, :key, :label, :description, :parent_id, :applies_to_files, :applies_to_notes) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':key', $key);
            $stmt->bindValue(':label', $label);
            $stmt->bindValue(':description', $description);
            $stmt->bindValue(':parent_id', $parentId !== '' ? $parentId : null);
            $stmt->bindValue(':applies_to_files', $appliesToFiles, PDO::PARAM_BOOL);
            $stmt->bindValue(':applies_to_notes', $appliesToNotes, PDO::PARAM_BOOL);
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
                    'applies_to_files' => $appliesToFiles,
                    'applies_to_notes' => $appliesToNotes,
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

        $this->requireMember($pdo, $user, $nookId);

        $keyCheck = $pdo->prepare('select key from global.note_types where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('type not found', 404);
        }
        if ($existingKey === self::ROOT_FILE_TYPE_KEY) {
            throw new HttpError('root file type cannot be modified', 400);
        }
        if ($existingKey === self::AI_MEMORY_TYPE_KEY) {
            throw new HttpError('ai-memory type cannot be modified', 400);
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

        $appliesToFiles = (bool)($data['applies_to_files'] ?? true);
        $appliesToNotes = (bool)($data['applies_to_notes'] ?? true);

        if ($parentId !== '') {
            $p = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $p->execute([':id' => $parentId, ':nook_id' => $nookId]);
            if (!$p->fetchColumn()) {
                throw new HttpError('parent not found', 404);
            }
        }

        if ($key !== $existingKey) {
            $dupe = $pdo->prepare('select 1 from global.note_types where nook_id = :nook_id and key = :key and id != :id');
            $dupe->execute([':nook_id' => $nookId, ':key' => $key, ':id' => $typeId]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }
        }

        $stmt = $pdo->prepare(
            'update global.note_types set key = :key, label = :label, description = :description, parent_id = :parent_id, applies_to_files = :applies_to_files, applies_to_notes = :applies_to_notes, updated_at = now() '
            . 'where id = :id and nook_id = :nook_id '
            . 'returning description, created_at, updated_at'
        );
        $stmt->bindValue(':id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':key', $key);
        $stmt->bindValue(':label', $label);
        $stmt->bindValue(':description', $description);
        $stmt->bindValue(':parent_id', $parentId !== '' ? $parentId : null);
        $stmt->bindValue(':applies_to_files', $appliesToFiles, PDO::PARAM_BOOL);
        $stmt->bindValue(':applies_to_notes', $appliesToNotes, PDO::PARAM_BOOL);
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
                'applies_to_files' => $appliesToFiles,
                'applies_to_notes' => $appliesToNotes,
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

        $this->requireMember($pdo, $user, $nookId);

        $keyCheck = $pdo->prepare('select key from global.note_types where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('type not found', 404);
        }
        if ($existingKey === self::ROOT_FILE_TYPE_KEY) {
            throw new HttpError('root file type cannot be deleted', 400);
        }
        if ($existingKey === self::AI_MEMORY_TYPE_KEY) {
            throw new HttpError('ai-memory type cannot be deleted', 400);
        }

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
        $whereSearch = '';
        if ($q !== '') {
            $whereSearch = 'and (lower(n.title) like :q or lower(n.content) like :q)';
        }

        $kind = strtolower(trim($request->queryParam('kind')));
        $whereKind = '';
        if ($kind !== '') {
            if (!in_array($kind, ['anything', 'person', 'file'], true)) {
                throw new HttpError('kind must be one of anything, person, file', 400);
            }
            $whereKind = 'and n.type = :kind';
        }

        $whereCursor = '';
        if ($cursorCreatedAt !== '' && $cursorId !== '') {
            $whereCursor = "and (n.{$sortCol}, n.id) {$cursorOp} (:cursor_sort_val::timestamptz, :cursor_id::uuid)";
        }

        $limitPlusOne = $limit + 1;

        $selectCols = 'select n.id, n.title, n.type, n.type_id, n.created_at, n.updated_at,
                    coalesce(outgoing.cnt, 0) as outgoing_mentions_count,
                    coalesce(incoming.cnt, 0) as incoming_mentions_count,
                    coalesce(outgoing_links.cnt, 0) as outgoing_links_count,
                    coalesce(incoming_links.cnt, 0) as incoming_links_count';
        $joinCounts = '
                left join (
                    select nm.source_note_id as note_id, count(*)::int as cnt
                    from global.note_mentions nm
                    join global.notes nn on nn.id = nm.source_note_id
                    where nn.nook_id = :nook_id
                    group by nm.source_note_id
                ) outgoing on outgoing.note_id = n.id
                left join (
                    select nm.target_note_id as note_id, count(*)::int as cnt
                    from global.note_mentions nm
                    join global.notes nn on nn.id = nm.target_note_id
                    where nn.nook_id = :nook_id
                    group by nm.target_note_id
                ) incoming on incoming.note_id = n.id
                left join (
                    select l.source_note_id as note_id, count(*)::int as cnt
                    from global.note_links l
                    where l.nook_id = :nook_id
                    group by l.source_note_id
                ) outgoing_links on outgoing_links.note_id = n.id
                left join (
                    select l.target_note_id as note_id, count(*)::int as cnt
                    from global.note_links l
                    where l.nook_id = :nook_id
                    group by l.target_note_id
                ) incoming_links on incoming_links.note_id = n.id';

        if ($isAll) {
            $stmt = $pdo->prepare(
                $selectCols . '
                from global.notes n'
                . $joinCounts . '
                where n.nook_id = :nook_id ' . $whereCursor . '
                ' . $whereSearch . '
                ' . $whereKind . '
                ' . $orderBy . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            if ($q !== '') {
                $stmt->bindValue(':q', '%' . $q . '%');
            }
            if ($kind !== '') {
                $stmt->bindValue(':kind', $kind);
            }
            if ($cursorCreatedAt !== '' && $cursorId !== '') {
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
                ' . $orderBy . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            if ($q !== '') {
                $stmt->bindValue(':q', '%' . $q . '%');
            }
            if ($kind !== '') {
                $stmt->bindValue(':kind', $kind);
            }
            if ($cursorCreatedAt !== '' && $cursorId !== '') {
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
                ' . $orderBy . '
                limit :limit'
            );

            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':limit', $limitPlusOne, PDO::PARAM_INT);
            if ($q !== '') {
                $stmt->bindValue(':q', '%' . $q . '%');
            }
            if ($kind !== '') {
                $stmt->bindValue(':kind', $kind);
            }
            if ($cursorCreatedAt !== '' && $cursorId !== '') {
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
                'type' => is_scalar($r['type'] ?? null) ? (string)$r['type'] : 'anything',
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
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

        return JsonResponse::ok([
            'notes' => $notes,
            'next_cursor' => $nextCursor,
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

    private function ensureAiMemoryType(PDO $pdo, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::AI_MEMORY_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, description, parent_id, applies_to_files, applies_to_notes) '
            . 'values (:nook_id, :key, :label, :description, null, false, true)'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::AI_MEMORY_TYPE_KEY,
            ':label' => 'AI Memory',
            ':description' => 'Notes that the AI assistant can read and write freely without requiring user approval.',
        ]);
    }

    private function ensureRootFileType(PDO $pdo, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::ROOT_FILE_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id, applies_to_files, applies_to_notes) '
            . 'values (:nook_id, :key, :label, null, true, false)'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::ROOT_FILE_TYPE_KEY,
            ':label' => 'Files',
        ]);
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
