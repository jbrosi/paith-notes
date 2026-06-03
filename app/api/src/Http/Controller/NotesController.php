<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Service\HeadingsService;
use Paith\Notes\Api\Http\Service\MentionsService;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Throwable;

final class NotesController
{
    private MentionsService $mentions;
    private HeadingsService $headings;

    public function __construct()
    {
        $this->mentions = new MentionsService();
        $this->headings = new HeadingsService();
    }

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

        $stmt = $pdo->prepare(
            'select n.id, n.title, n.type_id, n.created_at,
                coalesce(outgoing.cnt, 0) as outgoing_mentions_count,
                coalesce(incoming.cnt, 0) as incoming_mentions_count,
                coalesce(outgoing_links.cnt, 0) as outgoing_links_count,
                coalesce(incoming_links.cnt, 0) as incoming_links_count
            from global.notes n
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
            ) incoming_links on incoming_links.note_id = n.id
            where n.nook_id = :nook_id
            order by n.created_at desc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $notes[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'title' => is_scalar($r['title'] ?? null) ? (string)$r['title'] : '',
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'outgoing_mentions_count' => is_scalar($r['outgoing_mentions_count'] ?? null) ? (int)$r['outgoing_mentions_count'] : 0,
                'incoming_mentions_count' => is_scalar($r['incoming_mentions_count'] ?? null) ? (int)$r['incoming_mentions_count'] : 0,
                'outgoing_links_count' => is_scalar($r['outgoing_links_count'] ?? null) ? (int)$r['outgoing_links_count'] : 0,
                'incoming_links_count' => is_scalar($r['incoming_links_count'] ?? null) ? (int)$r['incoming_links_count'] : 0,
            ];
        }

        return JsonResponse::ok([
            'notes' => $notes,
        ]);
    }

    public function presence(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '' || !self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        $this->requireMember($pdo, $user, $nookId);

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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select id, title, content, type_id, attributes, archive, version, created_at '
            . 'from global.notes where nook_id = :nook_id and id = :id'
        );
        $stmt->execute([':nook_id' => $nookId, ':id' => $noteId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('note not found', 404);
        }

        $attributes = self::decodeJsonObject($r['attributes'] ?? null);
        $archive = self::decodeJsonObject($r['archive'] ?? null);

        $content = is_scalar($r['content'] ?? null) ? (string)$r['content'] : '';

        // Optional: extract a single section starting at a character offset.
        // Returns content from that position to the next heading of same or higher level.
        $sectionAt = trim($request->queryParam('section_at'));
        $sectionContent = null;
        if ($sectionAt !== '' && ctype_digit($sectionAt)) {
            $pos = (int)$sectionAt;
            $sectionContent = self::extractSection($content, $pos);
        }

        // Total view count for this note
        $vcStmt = $pdo->prepare('select coalesce(sum(count), 0) from global.note_views where note_id = :note_id');
        $vcStmt->execute([':note_id' => $noteId]);
        $vcCol = $vcStmt->fetchColumn();
        $viewCount = is_scalar($vcCol) ? (int)$vcCol : 0;

        $note = [
            'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
            'nook_id' => $nookId,
            'title' => is_scalar($r['title'] ?? null) ? (string)$r['title'] : '',
            'content' => $content,
            'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
            'attributes' => $attributes === [] ? (object)[] : $attributes,
            'archive' => $archive === [] ? (object)[] : $archive,
            'version' => Row::int($r, 'version'),
            'view_count' => $viewCount,
            'created_at' => Row::str($r, 'created_at'),
        ];

        if ($sectionContent !== null) {
            $note['section'] = $sectionContent;
        }

        // Include TOC (headings) for this note
        $hStmt = $pdo->prepare(
            'select level, text, position from global.note_headings where note_id = :note_id and nook_id = :nook_id order by position asc'
        );
        $hStmt->execute([':note_id' => $noteId, ':nook_id' => $nookId]);
        $hRows = $hStmt->fetchAll(PDO::FETCH_ASSOC);
        $headings = [];
        foreach ($hRows as $hr) {
            if (!is_array($hr)) continue;
            $headings[] = [
                'level' => (int)($hr['level'] ?? 0),
                'text' => (string)($hr['text'] ?? ''),
                'position' => (int)($hr['position'] ?? 0),
            ];
        }
        $note['headings'] = $headings;

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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '' || !self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select id, title, type_id, attributes, version, created_at, updated_at '
            . 'from global.notes where nook_id = :nook_id and id = :id'
        );
        $stmt->execute([':nook_id' => $nookId, ':id' => $noteId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('note not found', 404);
        }

        $hStmt = $pdo->prepare(
            'select level, text, position from global.note_headings where note_id = :note_id and nook_id = :nook_id order by position asc'
        );
        $hStmt->execute([':note_id' => $noteId, ':nook_id' => $nookId]);
        $headings = [];
        foreach ($hStmt->fetchAll(PDO::FETCH_ASSOC) as $hr) {
            if (!is_array($hr)) continue;
            $headings[] = [
                'level' => (int)($hr['level'] ?? 0),
                'text' => (string)($hr['text'] ?? ''),
                'position' => (int)($hr['position'] ?? 0),
            ];
        }

        return JsonResponse::ok([
            'summary' => [
                'id' => Row::str($r, 'id'),
                'nook_id' => $nookId,
                'title' => Row::str($r, 'title'),
                'type_id' => Row::str($r, 'type_id'),
                'attributes' => self::decodeJsonObject($r['attributes'] ?? null),
                'version' => Row::int($r, 'version'),
                'headings' => $headings,
                'created_at' => Row::str($r, 'created_at'),
                'updated_at' => Row::str($r, 'updated_at'),
            ],
        ]);
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

        $titleRaw = $data['title'] ?? '';
        $title = is_string($titleRaw) ? trim($titleRaw) : '';
        $contentRaw = $data['content'] ?? '';
        $content = is_string($contentRaw) ? $contentRaw : '';

        $typeIdRaw = $data['type_id'] ?? '';
        $typeId = is_string($typeIdRaw) ? trim($typeIdRaw) : '';
        if ($typeId !== '' && !self::isUuid($typeId)) {
            throw new HttpError('type_id must be a UUID', 400);
        }

        $attributes = is_array($data['attributes'] ?? null) ? $data['attributes'] : [];
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

        if ($typeId !== '') {
            $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            if (!$typeCheck->fetchColumn()) {
                throw new HttpError('type not found', 404);
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
                ':created_by' => $user['id'],
                ':title' => $title,
                ':content' => $content,
                ':type_id' => $typeId !== '' ? $typeId : null,
                ':attributes' => json_encode($attributes === [] ? (object)[] : $attributes),
                ':actor' => $context->actor(),
            ]);

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create note', 500);
            }

            $id = $row['id'] ?? '';
            $createdAt = $row['created_at'] ?? '';

            $noteId = is_scalar($id) ? (string)$id : '';
            if ($noteId !== '') {
                $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
                $this->mentions->syncMentions($pdo, $nookId, $noteId, $content, $userId);
                $this->headings->syncHeadings($pdo, $nookId, $noteId, $content);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => $content,
                    'type_id' => $typeId,
                    'attributes' => $attributes === [] ? (object)[] : $attributes,
                    'archive' => (object)[],
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

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $membership = NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $titleRaw = $data['title'] ?? '';
        $title = is_string($titleRaw) ? trim($titleRaw) : '';

        $contentRaw = $data['content'] ?? '';
        $content = is_string($contentRaw) ? $contentRaw : '';

        $allowed = false;
        $role = is_scalar($membership['role'] ?? null) ? (string)$membership['role'] : '';
        if ($role === 'owner') {
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
        $existingAttributes = self::decodeJsonObject($existingRow['attributes'] ?? null);
        $existingArchive = self::decodeJsonObject($existingRow['archive'] ?? null);

        $typeIdRaw = $data['type_id'] ?? null;
        $typeId = $existingTypeId !== '' ? $existingTypeId : null;
        if ($typeIdRaw !== null) {
            $typeIdStr = is_string($typeIdRaw) ? trim($typeIdRaw) : '';
            if ($typeIdStr !== '' && !self::isUuid($typeIdStr)) {
                throw new HttpError('type_id must be a UUID', 400);
            }
            $typeId = $typeIdStr !== '' ? $typeIdStr : null;
        }

        // Merge incoming attribute values (if provided) into existing attributes
        $incomingAttributes = $data['attributes'] ?? null;
        $attributes = $existingAttributes;
        if (is_array($incomingAttributes)) {
            foreach ($incomingAttributes as $k => $v) {
                if (!is_string($k)) {
                    continue;
                }
                if ($v === null) {
                    unset($attributes[$k]);
                } else {
                    $attributes[$k] = $v;
                }
            }
        }
        $archive = $existingArchive;

        if ($title === '') {
            $existingTitleStmt = $pdo->prepare('select title from global.notes where id = :id and nook_id = :nook_id');
            $existingTitleStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $existingTitle = $existingTitleStmt->fetchColumn();
            $title = is_string($existingTitle) ? trim($existingTitle) : '';
            if ($title === '') {
                throw new HttpError('title is required', 400);
            }
        }

        if ($typeId !== null) {
            $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            if (!$typeCheck->fetchColumn()) {
                throw new HttpError('type not found', 404);
            }
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
        $expectedVersion = $data['expected_version'] ?? null;
        if ($expectedVersion !== null && is_numeric($expectedVersion)) {
            $vStmt = $pdo->prepare('select version from global.notes where id = :id and nook_id = :nook_id');
            $vStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $vCol = $vStmt->fetchColumn();
            $currentVersion = is_scalar($vCol) ? (int)$vCol : 0;
            if ($currentVersion !== (int)$expectedVersion) {
                return JsonResponse::error('note was edited in the meantime', 409, [
                    'current_version' => $currentVersion,
                    'expected_version' => (int)$expectedVersion,
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

            $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $membership = NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $allowed = false;
        $role = is_scalar($membership['role'] ?? null) ? (string)$membership['role'] : '';
        if ($role === 'owner') {
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

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
            ':user_id' => $user['id'],
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
            ':user_id' => $user['id'],
        ]);
        $incomingRows = $incomingStmt->fetchAll(PDO::FETCH_ASSOC);

        $normalize = static function (array $r): array {
            return [
                'note_id' => is_scalar($r['note_id'] ?? null) ? (string)$r['note_id'] : '',
                'nook_id' => is_scalar($r['nook_id'] ?? null) ? (string)$r['nook_id'] : '',
                'note_title' => is_scalar($r['note_title'] ?? null) ? (string)$r['note_title'] : '',
                'link_title' => is_scalar($r['link_title'] ?? null) ? (string)$r['link_title'] : '',
                'position' => is_scalar($r['position'] ?? null) ? (int)$r['position'] : 0,
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '' || !self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $historyId = trim($request->routeParam('historyId'));
        if ($historyId === '') {
            throw new HttpError('historyId is required', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

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
                   and am.table_id = :table_id
                   and am.nook_id = :nook_id'
            );
            $stmt->execute([
                ':version' => $version,
                ':table_name' => 'notes',
                ':table_id' => $noteId,
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
                   and am.table_id = :table_id
                   and am.nook_id = :nook_id'
            );
            $stmt->execute([
                ':history_id' => (int)$historyId,
                ':table_name' => 'notes',
                ':table_id' => $noteId,
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

    public function history(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '' || !self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

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
            ':user_id' => $user['id'],
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
                        $entry['filename'] = is_scalar($fileData['filename'] ?? null) ? (string)$fileData['filename'] : '';
                        $entry['filesize'] = is_numeric($fileData['filesize'] ?? null) ? (int)$fileData['filesize'] : 0;
                        $entry['mime_type'] = is_scalar($fileData['mime_type'] ?? null) ? (string)$fileData['mime_type'] : '';
                    }
                }
            }
            $history[] = $entry;
        }

        return JsonResponse::ok(['history' => $history]);
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

    private function requireMember(PDO $pdo, array $user, string $nookId): array
    {
        $check = $pdo->prepare('select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([
            ':nook_id' => $nookId,
            ':user_id' => $user['id'],
        ]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('forbidden', 403);
        }
        return $row;
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }

    /** @return array<string, mixed> */
    private static function decodeJsonObject(mixed $value): array
    {
        if (!is_scalar($value)) {
            return [];
        }
        $decoded = json_decode((string)$value, true);
        if (!is_array($decoded)) {
            return [];
        }
        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /** @param array<string, mixed> $value */
    private static function encodeJsonObject(array $value): string
    {
        if ($value === []) {
            return '{}';
        }
        return (string)json_encode($value, JSON_UNESCAPED_SLASHES);
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
        if ($lines === []) {
            return '';
        }

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
}
