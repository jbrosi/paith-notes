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

final class NotesController
{
    private const NOTE_TYPE_ANYTHING = 'anything';
    private const NOTE_TYPE_PERSON = 'person';

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
            'select id, title, content, type, properties, former_properties, created_at from global.notes where nook_id = :nook_id order by created_at desc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $properties = self::decodeJsonObject($r['properties'] ?? null);
            $formerProperties = self::decodeJsonObject($r['former_properties'] ?? null);

            $notes[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'title' => is_scalar($r['title'] ?? null) ? (string)$r['title'] : '',
                'content' => is_scalar($r['content'] ?? null) ? (string)$r['content'] : '',
                'type' => is_scalar($r['type'] ?? null) ? (string)$r['type'] : self::NOTE_TYPE_ANYTHING,
                'properties' => $properties === [] ? (object)[] : $properties,
                'former_properties' => $formerProperties === [] ? (object)[] : $formerProperties,
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
            ];
        }

        return JsonResponse::ok([
            'notes' => $notes,
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
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

        $contentRaw = $data['content'] ?? '';
        $content = is_string($contentRaw) ? $contentRaw : '';

        $type = self::normalizeNoteType($data['type'] ?? null, self::NOTE_TYPE_ANYTHING);
        $properties = self::normalizeProperties($data['properties'] ?? null);

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                "insert into global.notes (nook_id, created_by, title, content, type, properties, former_properties) values (:nook_id, :created_by, :title, :content, :type, :properties, :former_properties) returning id, created_at"
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':created_by' => $user['id'],
                ':title' => $title,
                ':content' => $content,
                ':type' => $type,
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
                $this->syncMentions($pdo, $nookId, $noteId, $content);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => $content,
                    'type' => $type,
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
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

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

        $existingStmt = $pdo->prepare('select type, properties, former_properties from global.notes where id = :id and nook_id = :nook_id');
        $existingStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $existingRow = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($existingRow)) {
            throw new HttpError('note not found', 404);
        }

        $existingType = is_scalar($existingRow['type'] ?? null) ? (string)$existingRow['type'] : self::NOTE_TYPE_ANYTHING;
        $existingProperties = self::decodeJsonObject($existingRow['properties'] ?? null);
        $existingFormerProperties = self::decodeJsonObject($existingRow['former_properties'] ?? null);

        $type = self::normalizeNoteType($typeRaw, $existingType);
        $properties = $propertiesRaw === null ? $existingProperties : self::normalizeProperties($propertiesRaw);

        $formerProperties = $existingFormerProperties;

        if ($existingType === self::NOTE_TYPE_PERSON && $type !== self::NOTE_TYPE_PERSON) {
            $personFields = self::extractPersonFields($existingProperties);
            if ($personFields !== []) {
                $formerProperties['person'] = $personFields;
            }
            $properties = [];
        }

        if ($existingType !== self::NOTE_TYPE_PERSON && $type === self::NOTE_TYPE_PERSON) {
            if ($properties === [] && isset($formerProperties['person']) && is_array($formerProperties['person'])) {
                $properties = self::normalizeProperties($formerProperties['person']);
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'update global.notes set title = :title, content = :content, type = :type, properties = :properties, former_properties = :former_properties where id = :id and nook_id = :nook_id returning id, created_at'
            );
            $stmt->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':title' => $title,
                ':content' => $content,
                ':type' => $type,
                ':properties' => self::encodeJsonObject($properties),
                ':former_properties' => self::encodeJsonObject($formerProperties),
            ]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('note not found', 404);
            }

            $this->syncMentions($pdo, $nookId, $noteId, $content);

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

    private function syncMentions(PDO $pdo, string $nookId, string $sourceNoteId, string $markdown): void
    {
        $pdo->prepare('delete from global.note_mentions where source_note_id = :source_note_id')->execute([
            ':source_note_id' => $sourceNoteId,
        ]);

        $mentions = self::parseMentionsFromMarkdown($markdown);
        if ($mentions === []) {
            return;
        }

        $exists = $pdo->prepare('select 1 from global.notes where id = :id and nook_id = :nook_id');
        $insert = $pdo->prepare(
            'insert into global.note_mentions (source_note_id, target_note_id, position, link_title) values (:source_note_id, :target_note_id, :position, :link_title)'
        );

        foreach ($mentions as $m) {
            $target = $m['target_note_id'];
            $title = $m['link_title'];
            $offset = $m['offset'];
            if (!self::isUuid($target)) {
                continue;
            }

            $exists->execute([':id' => $target, ':nook_id' => $nookId]);
            if (!$exists->fetchColumn()) {
                continue;
            }

            $insert->execute([
                ':source_note_id' => $sourceNoteId,
                ':target_note_id' => $target,
                ':position' => $offset,
                ':link_title' => $title,
            ]);
        }
    }

    /** @return array<int, array{target_note_id: string, link_title: string, offset: int}> */
    private static function parseMentionsFromMarkdown(string $markdown): array
    {
        // Matches markdown links like: [Some Title](note:11111111-1111-4111-8111-111111111111)
        $pattern = '/\[(?<title>[^\]]+)\]\(note:(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/i';

        $matches = [];
        $count = preg_match_all($pattern, $markdown, $matches, PREG_OFFSET_CAPTURE);
        if (!is_int($count) || $count <= 0) {
            return [];
        }

        $out = [];
        $matchCount = count($matches['uuid']);
        for ($i = 0; $i < $matchCount; $i++) {
            $title = $matches['title'][$i][0] ?? '';
            $uuid = $matches['uuid'][$i][0] ?? '';
            $offset = $matches['uuid'][$i][1] ?? 0;

            $out[] = [
                'target_note_id' => $uuid,
                'link_title' => $title,
                'offset' => $offset,
            ];
        }

        usort($out, static fn (array $a, array $b): int => $a['offset'] <=> $b['offset']);
        return $out;
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
        if ($t === self::NOTE_TYPE_ANYTHING || $t === self::NOTE_TYPE_PERSON) {
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

    /** @param array<string, mixed> $properties @return array<string, string> */
    private static function extractPersonFields(array $properties): array
    {
        /** @var array<string, string> $out */
        $out = [];
        $first = $properties['first_name'] ?? null;
        $last = $properties['last_name'] ?? null;
        $dob = $properties['date_of_birth'] ?? null;

        if (is_string($first) && trim($first) !== '') {
            $out['first_name'] = trim($first);
        }
        if (is_string($last) && trim($last) !== '') {
            $out['last_name'] = trim($last);
        }
        if (is_string($dob) && trim($dob) !== '') {
            $out['date_of_birth'] = trim($dob);
        }

        return $out;
    }
}
