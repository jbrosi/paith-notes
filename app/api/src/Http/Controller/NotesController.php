<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Aws\S3\S3Client;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Env;
use PDO;
use Throwable;

final class NotesController
{
    private const NOTE_TYPE_ANYTHING = 'anything';
    private const NOTE_TYPE_PERSON = 'person';
    private const NOTE_TYPE_FILE = 'file';

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
            'select n.id, n.title, n.content, n.type, n.properties, n.former_properties, n.created_at,
                coalesce(outgoing.cnt, 0) as outgoing_mentions_count,
                coalesce(incoming.cnt, 0) as incoming_mentions_count
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
                'outgoing_mentions_count' => is_scalar($r['outgoing_mentions_count'] ?? null) ? (int)$r['outgoing_mentions_count'] : 0,
                'incoming_mentions_count' => is_scalar($r['incoming_mentions_count'] ?? null) ? (int)$r['incoming_mentions_count'] : 0,
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
        $contentRaw = $data['content'] ?? '';
        $content = is_string($contentRaw) ? $contentRaw : '';

        $type = self::normalizeNoteType($data['type'] ?? null, self::NOTE_TYPE_ANYTHING);
        $properties = self::normalizeProperties($data['properties'] ?? null);

        if ($title === '' && $type === self::NOTE_TYPE_PERSON) {
            $title = self::derivePersonTitle($properties);
        }
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

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

        if ($existingType !== $type) {
            if ($existingType === self::NOTE_TYPE_FILE || $type === self::NOTE_TYPE_FILE) {
                throw new HttpError('file note type cannot be changed', 400);
            }
        }

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

        if ($title === '' && $type === self::NOTE_TYPE_PERSON) {
            $title = self::derivePersonTitle($properties);
        }
        if ($title === '') {
            throw new HttpError('title is required', 400);
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

    public function fileUploadUrl(Request $request, Context $context): Response
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

        $membership = $this->requireMember($pdo, $user, $nookId);

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

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

        $typeStmt = $pdo->prepare('select type from global.notes where id = :id and nook_id = :nook_id');
        $typeStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $existingTypeRaw = $typeStmt->fetchColumn();
        $existingType = is_scalar($existingTypeRaw) ? (string)$existingTypeRaw : '';
        if ($existingType === '') {
            throw new HttpError('note not found', 404);
        }
        if ($existingType !== self::NOTE_TYPE_FILE) {
            throw new HttpError('note type must be file', 400);
        }

        $data = $request->jsonBody();

        $filenameRaw = $data['filename'] ?? '';
        $filename = is_string($filenameRaw) ? trim($filenameRaw) : '';
        if ($filename === '') {
            throw new HttpError('filename is required', 400);
        }

        $extensionRaw = $data['extension'] ?? '';
        $extension = is_string($extensionRaw) ? trim($extensionRaw) : '';

        $filesizeRaw = $data['filesize'] ?? 0;
        $filesize = is_numeric($filesizeRaw) ? (int)$filesizeRaw : 0;
        if ($filesize < 0) {
            $filesize = 0;
        }

        $mimeTypeRaw = $data['mime_type'] ?? '';
        $mimeType = is_string($mimeTypeRaw) ? trim($mimeTypeRaw) : '';

        $checksumRaw = $data['checksum'] ?? '';
        $checksum = is_string($checksumRaw) ? trim($checksumRaw) : '';

        $objectKey = sprintf('notes/%s/files/%s', $nookId, $noteId);

        $s3 = self::s3PresignClientForRequest($request);
        $bucket = self::filesBucketFromEnv();

        $params = [
            'Bucket' => $bucket,
            'Key' => $objectKey,
        ];

        $cmd = $s3->getCommand('PutObject', $params);
        $presigned = $s3->createPresignedRequest($cmd, '+15 minutes');

        $url = (string)$presigned->getUri();

        try {
            $pdo->beginTransaction();

            $upsert = $pdo->prepare(
                "insert into global.note_files (note_id, object_key, filename, extension, filesize, mime_type, checksum, updated_at)\n"
                . "values (:note_id, :object_key, :filename, :extension, :filesize, :mime_type, :checksum, now())\n"
                . "on conflict (note_id) do update set\n"
                . "    object_key = excluded.object_key,\n"
                . "    filename = excluded.filename,\n"
                . "    extension = excluded.extension,\n"
                . "    filesize = excluded.filesize,\n"
                . "    mime_type = excluded.mime_type,\n"
                . "    checksum = excluded.checksum,\n"
                . "    updated_at = now()"
            );
            $upsert->execute([
                ':note_id' => $noteId,
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => $filesize,
                ':mime_type' => $mimeType,
                ':checksum' => $checksum,
            ]);

            $properties = [
                'filename' => $filename,
                'extension' => $extension,
                'filesize' => $filesize,
                'mime_type' => $mimeType,
                'checksum' => $checksum,
            ];

            $updateProps = $pdo->prepare('update global.notes set properties = :properties where id = :id and nook_id = :nook_id');
            $updateProps->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':properties' => self::encodeJsonObject($properties),
            ]);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return JsonResponse::ok([
            'upload_url' => $url,
            'object_key' => $objectKey,
            'expires_in' => 900,
        ]);
    }

    public function fileDownloadUrl(Request $request, Context $context): Response
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
            'select nf.object_key, nf.filename, nf.mime_type from global.note_files nf join global.notes n on n.id = nf.note_id where nf.note_id = :note_id and n.nook_id = :nook_id'
        );
        $stmt->execute([':note_id' => $noteId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('file not found', 404);
        }

        $objectKey = is_scalar($row['object_key'] ?? null) ? (string)$row['object_key'] : '';
        if ($objectKey === '') {
            throw new HttpError('file not found', 404);
        }
        $filename = is_scalar($row['filename'] ?? null) ? (string)$row['filename'] : 'download';
        $mimeType = is_scalar($row['mime_type'] ?? null) ? (string)$row['mime_type'] : '';

        $inline = trim($request->queryParam('inline')) !== '';

        $s3 = self::s3PresignClientForRequest($request);
        $bucket = self::filesBucketFromEnv();

        $params = [
            'Bucket' => $bucket,
            'Key' => $objectKey,
            'ResponseContentDisposition' => sprintf(
                '%s; filename="%s"',
                $inline ? 'inline' : 'attachment',
                addslashes($filename)
            ),
        ];
        if ($mimeType !== '') {
            $params['ResponseContentType'] = $mimeType;
        }

        $cmd = $s3->getCommand('GetObject', $params);
        $presigned = $s3->createPresignedRequest($cmd, '+15 minutes');

        return JsonResponse::ok([
            'download_url' => (string)$presigned->getUri(),
            'expires_in' => 900,
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
        // Matches markdown note links like:
        // - [Some Title](note:11111111-1111-4111-8111-111111111111)
        // - ![Some Title](note:11111111-1111-4111-8111-111111111111)
        $pattern = '/!?\[(?<title>[^\]]*)\]\(note:(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\s+"(?<caption>[^"]*)")?\)/i';

        $matches = [];
        $count = preg_match_all($pattern, $markdown, $matches, PREG_OFFSET_CAPTURE);
        if (!is_int($count) || $count <= 0) {
            return [];
        }

        $out = [];
        $matchCount = count($matches['uuid']);
        for ($i = 0; $i < $matchCount; $i++) {
            $title = $matches['title'][$i][0] ?? '';
            $caption = $matches['caption'][$i][0] ?? '';
            $uuid = $matches['uuid'][$i][0] ?? '';
            $offset = $matches['uuid'][$i][1] ?? 0;

            $linkTitle = trim((string)$caption);
            if ($linkTitle === '') {
                $linkTitle = trim((string)$title);
            }

            $out[] = [
                'target_note_id' => $uuid,
                'link_title' => $linkTitle,
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
        if ($t === self::NOTE_TYPE_ANYTHING || $t === self::NOTE_TYPE_PERSON || $t === self::NOTE_TYPE_FILE) {
            return $t;
        }
        return $default;
    }

    private static function s3PresignClientFromEnv(): S3Client
    {
        $endpoint = Env::get('S3_PUBLIC_ENDPOINT');
        if ($endpoint === '') {
            $endpoint = Env::get('S3_ENDPOINT');
        }

        $accessKey = Env::get('S3_ACCESS_KEY');
        $secretKey = Env::get('S3_SECRET_KEY');

        if ($endpoint === '' || $accessKey === '' || $secretKey === '') {
            throw new HttpError('S3 is not configured', 500);
        }

        $endpoint = preg_replace('#/+$#', '', $endpoint) ?? $endpoint;

        return new S3Client([
            'version' => 'latest',
            'region' => 'us-east-1',
            'endpoint' => $endpoint,
            'use_path_style_endpoint' => true,
            'credentials' => [
                'key' => $accessKey,
                'secret' => $secretKey,
            ],
        ]);
    }

    private static function s3PresignClientForRequest(Request $request): S3Client
    {
        $public = '';

        $host = trim($request->header('Host'));
        if ($host !== '') {
            $proto = trim($request->header('X-Forwarded-Proto'));
            if ($proto === '') {
                $proto = 'http';
            }
            $public = $proto . '://' . $host;
        }

        if ($public === '') {
            $public = Env::get('S3_PUBLIC_ENDPOINT');
        }

        if ($public === '') {
            return self::s3PresignClientFromEnv();
        }

        $accessKey = Env::get('S3_ACCESS_KEY');
        $secretKey = Env::get('S3_SECRET_KEY');
        if ($accessKey === '' || $secretKey === '') {
            throw new HttpError('S3 is not configured', 500);
        }

        $public = preg_replace('#/+$#', '', $public) ?? $public;

        return new S3Client([
            'version' => 'latest',
            'region' => 'us-east-1',
            'endpoint' => $public,
            'use_path_style_endpoint' => true,
            'credentials' => [
                'key' => $accessKey,
                'secret' => $secretKey,
            ],
        ]);
    }

    private static function filesBucketFromEnv(): string
    {
        $bucket = Env::get('S3_FILES_BUCKET');
        if ($bucket === '') {
            $bucket = Env::get('S3_BUCKET');
        }
        if ($bucket === '') {
            throw new HttpError('S3 is not configured', 500);
        }
        return $bucket;
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

    /** @param array<string, mixed> $properties */
    private static function derivePersonTitle(array $properties): string
    {
        $first = $properties['first_name'] ?? null;
        $last = $properties['last_name'] ?? null;

        $firstName = is_string($first) ? trim($first) : '';
        $lastName = is_string($last) ? trim($last) : '';

        return trim($firstName . ' ' . $lastName);
    }

    /** @param array<string, mixed> $properties @return array<string, string> */
    private static function extractPersonFields(array $properties): array
    {
        $person = [];

        $firstName = $properties['first_name'] ?? null;
        if (is_string($firstName) && trim($firstName) !== '') {
            $person['first_name'] = trim($firstName);
        }

        $lastName = $properties['last_name'] ?? null;
        if (is_string($lastName) && trim($lastName) !== '') {
            $person['last_name'] = trim($lastName);
        }

        $dob = $properties['date_of_birth'] ?? null;
        if (is_string($dob) && trim($dob) !== '') {
            $person['date_of_birth'] = trim($dob);
        }

        return $person;
    }
}
