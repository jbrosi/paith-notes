<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Service\MentionsService;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use Throwable;

final class NotesController
{
    private const NOTE_TYPE_ANYTHING = 'anything';
    private const NOTE_TYPE_PERSON = 'person';
    private const NOTE_TYPE_FILE = 'file';

    private MentionsService $mentions;

    public function __construct()
    {
        $this->mentions = new MentionsService();
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
            'select n.id, n.title, n.type, n.type_id, n.created_at,
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
                'type' => is_scalar($r['type'] ?? null) ? (string)$r['type'] : self::NOTE_TYPE_ANYTHING,
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
            'select id, title, content, type, type_id, properties, former_properties, created_at '
            . 'from global.notes where nook_id = :nook_id and id = :id'
        );
        $stmt->execute([':nook_id' => $nookId, ':id' => $noteId]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($r)) {
            throw new HttpError('note not found', 404);
        }

        $properties = self::decodeJsonObject($r['properties'] ?? null);
        $formerProperties = self::decodeJsonObject($r['former_properties'] ?? null);

        return JsonResponse::ok([
            'note' => [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'title' => is_scalar($r['title'] ?? null) ? (string)$r['title'] : '',
                'content' => is_scalar($r['content'] ?? null) ? (string)$r['content'] : '',
                'type' => is_scalar($r['type'] ?? null) ? (string)$r['type'] : self::NOTE_TYPE_ANYTHING,
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
                'properties' => $properties === [] ? (object)[] : $properties,
                'former_properties' => $formerProperties === [] ? (object)[] : $formerProperties,
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
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

        $this->requireMember($pdo, $user, $nookId);

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

        $type = self::normalizeNoteType($data['type'] ?? null, self::NOTE_TYPE_ANYTHING);
        $properties = self::normalizeProperties($data['properties'] ?? null);
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

        if ($typeId !== '') {
            $typeCheck = $pdo->prepare('select applies_to_files, applies_to_notes from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            $typeRow = $typeCheck->fetch(PDO::FETCH_ASSOC);
            if (!is_array($typeRow)) {
                throw new HttpError('type not found', 404);
            }
            $appliesToFiles = (bool)($typeRow['applies_to_files'] ?? true);
            $appliesToNotes = (bool)($typeRow['applies_to_notes'] ?? true);
            if ($type === self::NOTE_TYPE_FILE) {
                if (!$appliesToFiles) {
                    throw new HttpError('type does not apply to files', 400);
                }
            } else {
                if (!$appliesToNotes) {
                    throw new HttpError('type does not apply to notes', 400);
                }
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                "insert into global.notes (nook_id, created_by, title, content, type, type_id, properties, former_properties) values (:nook_id, :created_by, :title, :content, :type, :type_id, :properties, :former_properties) returning id, created_at"
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':created_by' => $user['id'],
                ':title' => $title,
                ':content' => $content,
                ':type' => $type,
                ':type_id' => $typeId !== '' ? $typeId : null,
                ':properties' => self::encodeJsonObject($properties),
                ':former_properties' => '{}',
            ]);

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create note', 500);
            }

            $id = $row['id'] ?? '';
            $createdAt = $row['created_at'] ?? '';

            $noteId = is_scalar($id) ? (string)$id : '';
            if ($noteId !== '') {
                $this->mentions->syncMentions($pdo, $nookId, $noteId, $content);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => $content,
                    'type' => $type,
                    'type_id' => $typeId,
                    'properties' => $properties === [] ? (object)[] : $properties,
                    'former_properties' => (object)[],
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

        $membership = $this->requireMember($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $titleRaw = $data['title'] ?? '';
        $title = is_string($titleRaw) ? trim($titleRaw) : '';

        $contentRaw = $data['content'] ?? '';
        $content = is_string($contentRaw) ? $contentRaw : '';

        $typeRaw = $data['type'] ?? null;
        $propertiesRaw = $data['properties'] ?? null;

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

        $existingStmt = $pdo->prepare('select type, type_id, properties, former_properties from global.notes where id = :id and nook_id = :nook_id');
        $existingStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $existingRow = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($existingRow)) {
            throw new HttpError('note not found', 404);
        }

        $existingType = is_scalar($existingRow['type'] ?? null) ? (string)$existingRow['type'] : self::NOTE_TYPE_ANYTHING;
        $existingTypeId = is_scalar($existingRow['type_id'] ?? null) ? trim((string)$existingRow['type_id']) : '';
        $existingProperties = self::decodeJsonObject($existingRow['properties'] ?? null);
        $existingFormerProperties = self::decodeJsonObject($existingRow['former_properties'] ?? null);

        $typeIdRaw = $data['type_id'] ?? null;
        $typeId = $existingTypeId !== '' ? $existingTypeId : null;
        if ($typeIdRaw !== null) {
            $typeIdStr = is_string($typeIdRaw) ? trim($typeIdRaw) : '';
            if ($typeIdStr !== '' && !self::isUuid($typeIdStr)) {
                throw new HttpError('type_id must be a UUID', 400);
            }
            $typeId = $typeIdStr !== '' ? $typeIdStr : null;
        }

        $type = self::normalizeNoteType($typeRaw, $existingType);
        $properties = $propertiesRaw === null ? $existingProperties : self::normalizeProperties($propertiesRaw);

        if ($existingType !== $type) {
            if ($existingType === self::NOTE_TYPE_FILE || $type === self::NOTE_TYPE_FILE) {
                throw new HttpError('file note type cannot be changed', 400);
            }
        }

        $formerProperties = $existingFormerProperties;
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

        if ($typeId !== null) {
            $typeCheck = $pdo->prepare('select applies_to_files, applies_to_notes from global.note_types where id = :id and nook_id = :nook_id');
            $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
            $typeRow = $typeCheck->fetch(PDO::FETCH_ASSOC);
            if (!is_array($typeRow)) {
                throw new HttpError('type not found', 404);
            }
            $appliesToFiles = (bool)($typeRow['applies_to_files'] ?? true);
            $appliesToNotes = (bool)($typeRow['applies_to_notes'] ?? true);
            if ($type === self::NOTE_TYPE_FILE) {
                if (!$appliesToFiles) {
                    throw new HttpError('type does not apply to files', 400);
                }
            } else {
                if (!$appliesToNotes) {
                    throw new HttpError('type does not apply to notes', 400);
                }
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'update global.notes set title = :title, content = :content, type = :type, type_id = :type_id, properties = :properties, former_properties = :former_properties, updated_at = now() where id = :id and nook_id = :nook_id returning id, created_at, updated_at'
            );
            $stmt->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':title' => $title,
                ':content' => $content,
                ':type' => $type,
                ':type_id' => $typeId,
                ':properties' => self::encodeJsonObject($properties),
                ':former_properties' => self::encodeJsonObject($formerProperties),
            ]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('note not found', 404);
            }

            $this->mentions->syncMentions($pdo, $nookId, $noteId, $content);

            $pdo->commit();

            $id = $row['id'] ?? '';
            $createdAt = $row['created_at'] ?? '';

            return JsonResponse::ok([
                'note' => [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => $content,
                    'type' => $type,
                    'type_id' => is_string($typeId) ? $typeId : '',
                    'properties' => $properties === [] ? (object)[] : $properties,
                    'former_properties' => $formerProperties === [] ? (object)[] : $formerProperties,
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

        $membership = $this->requireMember($pdo, $user, $nookId);

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

        $outgoingStmt = $pdo->prepare(
            'select m.target_note_id as note_id, n.title as note_title, m.link_title, m.position '
            . 'from global.note_mentions m '
            . 'join global.notes n on n.id = m.target_note_id '
            . 'where m.source_note_id = :source_note_id and n.nook_id = :nook_id '
            . 'order by m.position asc'
        );
        $outgoingStmt->execute([
            ':source_note_id' => $noteId,
            ':nook_id' => $nookId,
        ]);
        $outgoingRows = $outgoingStmt->fetchAll(PDO::FETCH_ASSOC);

        $incomingStmt = $pdo->prepare(
            'select m.source_note_id as note_id, n.title as note_title, m.link_title, m.position '
            . 'from global.note_mentions m '
            . 'join global.notes n on n.id = m.source_note_id '
            . 'where m.target_note_id = :target_note_id and n.nook_id = :nook_id '
            . 'order by m.position asc'
        );
        $incomingStmt->execute([
            ':target_note_id' => $noteId,
            ':nook_id' => $nookId,
        ]);
        $incomingRows = $incomingStmt->fetchAll(PDO::FETCH_ASSOC);

        $normalize = static function (array $r): array {
            return [
                'note_id' => is_scalar($r['note_id'] ?? null) ? (string)$r['note_id'] : '',
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

    private static function normalizeNoteType(mixed $value, string $default): string
    {
        if (!is_string($value)) {
            return $default;
        }
        $t = trim($value);
        if ($t === '') {
            return $default;
        }
        if ($t === self::NOTE_TYPE_ANYTHING || $t === self::NOTE_TYPE_PERSON || $t === self::NOTE_TYPE_FILE) {
            return $t;
        }
        return $default;
    }

    /** @return array<string, mixed> */
    private static function normalizeProperties(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        /** @var array<string, mixed> $value */
        return $value;
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
}
