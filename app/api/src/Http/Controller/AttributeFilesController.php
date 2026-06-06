<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\Cookies;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Throwable;
use Paith\Notes\Shared\Uuid;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\Auth\User;

/**
 * Handles file upload/download for file-kind type attributes.
 *
 * Endpoints:
 *  - uploadUrl:  POST /nooks/{nookId}/notes/{noteId}/attributes/{attributeId}/file/upload-url
 *  - finalize:   POST /nooks/{nookId}/notes/{noteId}/attributes/{attributeId}/file/finalize
 *  - downloadUrl: GET /nooks/{nookId}/notes/{noteId}/attributes/{attributeId}/file/download-url
 *
 * Init + finalize flow for creating a new note with a file:
 *  - uploadUrlInit:  POST /nooks/{nookId}/file/upload-url  (accepts attribute_id, type_id)
 *  - finalizeCreate: POST /nooks/{nookId}/file/finalize     (accepts attribute_id, type_id)
 */
final class AttributeFilesController
{
    /**
     * Generate an upload URL for a file attribute on an existing note.
     */
    public function uploadUrl(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $sessionId = $this->extractSessionId($request);

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $noteId = self::requireUuid($request->routeParam('noteId'), 'noteId');
        $attributeId = self::requireUuid($request->routeParam('attributeId'), 'attributeId');

        $role = NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $userId = self::requireUserId($user);
        $this->requireNoteWriteAccess($pdo, $role, $userId, $noteId, $nookId);
        $this->requireFileAttribute($pdo, $nookId, $noteId, $attributeId);

        $data = $request->jsonBody();
        $file = $this->parseFileMetadata($data);

        $uploadId = $this->generateUuid($pdo);
        $tempObjectKey = 'tmp/' . $uploadId;
        $url = $this->filePublicUrlForRequest($request, $tempObjectKey);

        try {
            $pdo->beginTransaction();

            // Upsert note_files entry — bumps file_version on re-upload
            $fileVersion = $this->upsertNoteFile($pdo, $noteId, $attributeId, '', $file, $nookId, $userId);
            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $attributeId, $fileVersion);

            // Update object_key now that we know the version
            $pdo->prepare('update global.note_files set object_key = :key where note_id = :note_id')
                ->execute([':key' => $objectKey, ':note_id' => $noteId]);

            // Create upload record
            $this->createUpload($pdo, $uploadId, $noteId, $userId, $tempObjectKey, $objectKey, $sessionId, $nookId, $file);

            // Set note attribute to just the file_version
            $this->updateNoteFileAttribute($pdo, $noteId, $nookId, $attributeId, $fileVersion);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return JsonResponse::ok([
            'upload_url' => $url,
            'upload_id' => $uploadId,
            'temp_object_key' => $tempObjectKey,
            'object_key' => $objectKey,
            'expires_in' => 0,
        ]);
    }

    /**
     * Finalize a file upload for a file attribute on an existing note.
     */
    public function finalize(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $sessionId = $this->extractSessionId($request);

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $noteId = self::requireUuid($request->routeParam('noteId'), 'noteId');
        $attributeId = self::requireUuid($request->routeParam('attributeId'), 'attributeId');

        $role = NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $userId = self::requireUserId($user);
        $this->requireNoteWriteAccess($pdo, $role, $userId, $noteId, $nookId);

        $data = $request->jsonBody();
        $uploadId = self::requireUuid($data['upload_id'] ?? null, 'upload_id');

        try {
            $pdo->beginTransaction();

            $upload = $this->lockUpload($pdo, $uploadId, $noteId, $userId, $sessionId);
            $tempObjectKey = $upload['temp_object_key'];
            $finalObjectKey = $upload['final_object_key'];

            $this->validateAndMoveFile($pdo, $noteId, $tempObjectKey, $finalObjectKey);

            // Update filesize/checksum from the final file on disk
            $finalPath = self::dataPath() . '/' . ltrim($finalObjectKey, '/');
            $serverFilesize = @filesize($finalPath);
            $serverFilesize = is_int($serverFilesize) ? max(0, $serverFilesize) : 0;
            $serverChecksum = @hash_file('sha256', $finalPath);
            $serverChecksum = is_string($serverChecksum) ? trim($serverChecksum) : '';
            $pdo->prepare(
                'update global.note_files set filesize = :filesize, checksum = :checksum, updated_at = now() '
                . 'where note_id = :note_id and attribute_id = :attribute_id'
            )->execute([
                ':filesize' => $serverFilesize,
                ':checksum' => $serverChecksum,
                ':note_id' => $noteId,
                ':attribute_id' => $attributeId,
            ]);

            $upd = $pdo->prepare('update global.file_uploads set finalized_at = now() where id = :id and finalized_at is null');
            $upd->execute([':id' => $uploadId]);
            if ($upd->rowCount() !== 1) {
                throw new HttpError('upload already finalized', 409);
            }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return JsonResponse::ok([
            'object_key' => $finalObjectKey,
        ]);
    }

    /**
     * Generate a download URL for a file attribute on a note.
     */
    public function downloadUrl(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $noteId = self::requireUuid($request->routeParam('noteId'), 'noteId');
        $attributeId = self::requireUuid($request->routeParam('attributeId'), 'attributeId');

        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select nf.object_key, nf.filename, nf.mime_type '
            . 'from global.note_files nf '
            . 'join global.notes n on n.id = nf.note_id '
            . 'where nf.note_id = :note_id and nf.attribute_id = :attribute_id and n.nook_id = :nook_id'
        );
        $stmt->execute([':note_id' => $noteId, ':attribute_id' => $attributeId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('file not found', 404);
        }

        $objectKey = Row::str($row, 'object_key');
        if ($objectKey === '') {
            throw new HttpError('file not found', 404);
        }

        $inline = trim($request->queryParam('inline')) !== '';
        $url = $this->filePublicUrlForRequest($request, $objectKey, [
            'inline' => $inline ? '1' : '',
        ]);

        return JsonResponse::ok([
            'download_url' => $url,
            'expires_in' => 0,
        ]);
    }

    /**
     * Init upload for a new note with a file attribute.
     * POST /nooks/{nookId}/file/upload-url
     * Body: { filename, extension, filesize, mime_type, checksum, type_id, attribute_id }
     */
    public function uploadUrlInit(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $sessionId = $this->extractSessionId($request);

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $userId = self::requireUserId($user);

        $data = $request->jsonBody();
        $file = $this->parseFileMetadata($data);

        // type_id and attribute_id are required for the new flow
        $typeId = self::requireUuid($data['type_id'] ?? null, 'type_id');
        $attributeId = self::requireUuid($data['attribute_id'] ?? null, 'attribute_id');

        // Validate the type and attribute exist and attribute is a file kind
        $this->requireTypeAttribute($pdo, $nookId, $typeId, $attributeId);

        $uploadId = $this->generateUuid($pdo);
        $tempObjectKey = 'tmp/' . $uploadId;
        $url = $this->filePublicUrlForRequest($request, $tempObjectKey);

        $insUpload = $pdo->prepare(
            "insert into global.file_uploads (id, nook_id, created_by, temp_object_key, session_id, expires_at, filename, extension, mime_type, expected_filesize, expected_checksum) "
            . "values (:id, :nook_id, :created_by, :temp_object_key, :session_id, now() + interval '15 minutes', :filename, :extension, :mime_type, :expected_filesize, :expected_checksum)"
        );
        $insUpload->execute([
            ':id' => $uploadId,
            ':nook_id' => $nookId,
            ':created_by' => $userId,
            ':temp_object_key' => $tempObjectKey,
            ':session_id' => $sessionId !== '' ? $sessionId : null,
            ':filename' => $file['filename'],
            ':extension' => $file['extension'],
            ':mime_type' => $file['mime_type'],
            ':expected_filesize' => $file['filesize'],
            ':expected_checksum' => $file['checksum'],
        ]);

        return JsonResponse::ok([
            'upload_url' => $url,
            'upload_id' => $uploadId,
            'temp_object_key' => $tempObjectKey,
            'expires_in' => 0,
        ]);
    }

    /**
     * Finalize upload and create a new note with a file attribute.
     * POST /nooks/{nookId}/file/finalize
     * Body: { upload_id, type_id, attribute_id, title? }
     */
    public function finalizeCreateNote(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $sessionId = $this->extractSessionId($request);

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $userId = self::requireUserId($user);

        $data = $request->jsonBody();
        $uploadId = self::requireUuid($data['upload_id'] ?? null, 'upload_id');
        $typeId = self::requireUuid($data['type_id'] ?? null, 'type_id');
        $attributeId = self::requireUuid($data['attribute_id'] ?? null, 'attribute_id');

        $this->requireTypeAttribute($pdo, $nookId, $typeId, $attributeId);

        try {
            $pdo->beginTransaction();

            // Lock and validate the upload
            $stmt = $pdo->prepare(
                "select nook_id, temp_object_key, session_id, put_claimed_at, filename, extension, mime_type, expected_filesize, expected_checksum "
                . "from global.file_uploads "
                . "where id = :id and created_by = :created_by and finalized_at is null and expires_at > now() "
                . "for update"
            );
            $stmt->execute([':id' => $uploadId, ':created_by' => $userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('upload not found', 404);
            }

            $uploadNookId = Row::str($row, 'nook_id');
            if ($uploadNookId !== $nookId) {
                throw new HttpError('not found', 404);
            }

            $tempObjectKey = Row::str($row, 'temp_object_key');
            $uploadSessionId = is_scalar($row['session_id'] ?? null) ? trim((string)$row['session_id']) : '';
            $putClaimedAt = $row['put_claimed_at'] ?? null;

            if ($tempObjectKey === '') {
                throw new HttpError('upload invalid', 500);
            }
            if (!is_scalar($putClaimedAt) || trim((string)$putClaimedAt) === '') {
                throw new HttpError('upload not complete', 409);
            }
            if ($uploadSessionId !== '' && ($sessionId === '' || $sessionId !== $uploadSessionId)) {
                throw new HttpError('not authorized', 403);
            }

            $filename = trim(Row::str($row, 'filename', 'upload'));
            if ($filename === '') {
                $filename = 'upload';
            }
            $extension = trim(Row::str($row, 'extension'));
            $mimeType = trim(Row::str($row, 'mime_type'));
            $expectedFilesize = max(0, Row::int($row, 'expected_filesize'));
            $expectedChecksum = trim(Row::str($row, 'expected_checksum'));

            $from = self::dataPath() . '/' . ltrim($tempObjectKey, '/');
            if (!file_exists($from)) {
                throw new HttpError('temp upload missing', 404);
            }

            $serverFilesize = @filesize($from);
            $serverFilesize = is_int($serverFilesize) ? max(0, $serverFilesize) : 0;
            if ($expectedFilesize > 0 && $serverFilesize !== $expectedFilesize) {
                throw new HttpError('upload incomplete (filesize mismatch)', 400);
            }

            $serverChecksum = @hash_file('sha256', $from);
            $serverChecksum = is_string($serverChecksum) ? trim($serverChecksum) : '';
            if ($expectedChecksum !== '' && $serverChecksum !== '' && $serverChecksum !== $expectedChecksum) {
                throw new HttpError('upload corrupted (checksum mismatch)', 400);
            }

            // Determine note title
            $title = JsonReader::optionalTrimmedString($data, 'title');
            if ($title === '') {
                $title = $filename;
            }

            // Pre-generate note ID so we can build the path before INSERT.
            // INSERT first (validates UUID uniqueness), then move the file.
            $genStmt = $pdo->query('select gen_random_uuid()::text');
            $genId = $genStmt !== false ? $genStmt->fetchColumn() : null;
            $noteId = is_string($genId) ? trim($genId) : '';
            if ($noteId === '') {
                throw new HttpError('failed to generate note id', 500);
            }

            $fileVersion = 1;
            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $attributeId, $fileVersion);
            $attributes = [$attributeId => ['file_version' => $fileVersion]];

            // Create the note first — if UUID collides, this fails safely
            // before we touch any files on disk.
            $noteStmt = $pdo->prepare(
                "insert into global.notes (id, nook_id, created_by, title, content, type_id, attributes) "
                . "values (:id, :nook_id, :created_by, :title, '', :type_id, :attributes::jsonb) "
                . "returning created_at"
            );
            $noteStmt->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':created_by' => $userId,
                ':title' => $title,
                ':type_id' => $typeId,
                ':attributes' => json_encode($attributes),
            ]);

            $noteRow = $noteStmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($noteRow)) {
                throw new HttpError('failed to create note', 500);
            }

            $createdAt = Row::str($noteRow, 'created_at');

            // Move file to final location (safe — note ID is confirmed unique)
            $to = self::dataPath() . '/' . ltrim($objectKey, '/');
            $dir = dirname($to);
            if (!is_dir($dir)) {
                if (!mkdir($dir, 0777, true) && !is_dir($dir)) {
                    throw new HttpError('failed to create final dir', 500);
                }
            }
            if (!rename($from, $to)) {
                throw new HttpError('failed to finalize upload', 500);
            }

            // Insert note_files record
            $pdo->prepare(
                "insert into global.note_files (note_id, attribute_id, object_key, filename, extension, filesize, mime_type, checksum, file_version, uploaded_by, nook_id, updated_at) "
                . "values (:note_id, :attribute_id, :object_key, :filename, :extension, :filesize, :mime_type, :checksum, :file_version, :uploaded_by, :nook_id, now())"
            )->execute([
                ':note_id' => $noteId,
                ':attribute_id' => $attributeId,
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => $serverFilesize,
                ':mime_type' => $mimeType,
                ':checksum' => $serverChecksum,
                ':file_version' => $fileVersion,
                ':uploaded_by' => $userId,
                ':nook_id' => $nookId,
            ]);

            // Mark upload finalized
            $updUpload = $pdo->prepare(
                'update global.file_uploads set note_id = :note_id, finalized_note_id = :note_id, final_object_key = :final_object_key, finalized_at = now() where id = :id and finalized_at is null'
            );
            $updUpload->execute([
                ':id' => $uploadId,
                ':note_id' => $noteId,
                ':final_object_key' => $objectKey,
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => $noteId,
                    'nook_id' => $nookId,
                    'title' => $title,
                    'content' => '',
                    'type_id' => $typeId,
                    'attributes' => $attributes,
                    'archive' => (object)[],
                    'created_at' => $createdAt,
                ],
                'object_key' => $objectKey,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /**
     * @param array<string, mixed> $data
     * @return array{filename: string, extension: string, filesize: int, mime_type: string, checksum: string}
     */
    private function parseFileMetadata(array $data): array
    {
        $filename = JsonReader::optionalTrimmedString($data, 'filename');
        if ($filename === '') {
            throw new HttpError('filename is required', 400);
        }
        return [
            'filename' => $filename,
            'extension' => JsonReader::optionalTrimmedString($data, 'extension'),
            'filesize' => is_numeric($data['filesize'] ?? null) ? max(0, (int)$data['filesize']) : 0,
            'mime_type' => JsonReader::optionalTrimmedString($data, 'mime_type'),
            'checksum' => JsonReader::optionalTrimmedString($data, 'checksum'),
        ];
    }

    /**
     * Verify the attribute exists on the note's type (or ancestors) and is kind=file.
     */
    private function requireFileAttribute(PDO $pdo, string $nookId, string $noteId, string $attributeId): void
    {
        $typeStmt = $pdo->prepare('select type_id from global.notes where id = :id and nook_id = :nook_id');
        $typeStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $typeId = $typeStmt->fetchColumn();
        if (!is_scalar($typeId) || trim((string)$typeId) === '') {
            throw new HttpError('note has no type assigned', 400);
        }
        $this->requireTypeAttribute($pdo, $nookId, (string)$typeId, $attributeId);
    }

    /**
     * Verify the attribute exists on the type (or ancestors) and is kind=file.
     */
    private function requireTypeAttribute(PDO $pdo, string $nookId, string $typeId, string $attributeId): void
    {
        $stmt = $pdo->prepare(
            'with recursive type_tree as (
                select id from global.note_types where id = :type_id and nook_id = :nook_id
                union all
                select t.parent_id from global.note_types t
                join type_tree tt on t.id = tt.id
                where t.parent_id is not null
            )
            select ta.kind from global.type_attributes ta
            join type_tree tt on ta.type_id = tt.id
            where ta.id = :attr_id'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':attr_id', $attributeId);
        $stmt->execute();
        $kind = $stmt->fetchColumn();
        if ($kind === false) {
            throw new HttpError('attribute not found on this type', 404);
        }
        if ((string)$kind !== 'file') {
            throw new HttpError('attribute is not a file kind', 400);
        }
    }

    /**
     * Upsert note_files row, bumping file_version on re-upload.
     * Returns the new file_version.
     *
     * @param array{filename: string, extension: string, filesize: int, mime_type: string, checksum: string} $file
     */
    private function upsertNoteFile(PDO $pdo, string $noteId, string $attributeId, string $objectKey, array $file, string $nookId, string $userId): int
    {
        $stmt = $pdo->prepare(
            "insert into global.note_files (note_id, attribute_id, object_key, filename, extension, filesize, mime_type, checksum, file_version, uploaded_by, nook_id, updated_at) "
            . "values (:note_id, :attribute_id, :object_key, :filename, :extension, :filesize, :mime_type, :checksum, 1, :uploaded_by, :nook_id, now()) "
            . "on conflict (note_id) do update set "
            . "    attribute_id = excluded.attribute_id, object_key = excluded.object_key, "
            . "    filename = excluded.filename, extension = excluded.extension, "
            . "    filesize = excluded.filesize, mime_type = excluded.mime_type, "
            . "    checksum = excluded.checksum, uploaded_by = excluded.uploaded_by, "
            . "    file_version = global.note_files.file_version + 1, "
            . "    updated_at = now() "
            . "returning file_version"
        );
        $stmt->execute([
            ':note_id' => $noteId,
            ':attribute_id' => $attributeId,
            ':object_key' => $objectKey,
            ':filename' => $file['filename'],
            ':extension' => $file['extension'],
            ':filesize' => $file['filesize'],
            ':mime_type' => $file['mime_type'],
            ':checksum' => $file['checksum'],
            ':uploaded_by' => $userId,
            ':nook_id' => $nookId,
        ]);
        $ver = $stmt->fetchColumn();
        return is_scalar($ver) ? (int)$ver : 1;
    }

    /** @param array{filename: string, extension: string, filesize: int, mime_type: string, checksum: string} $file */
    private function createUpload(PDO $pdo, string $uploadId, string $noteId, string $userId, string $tempObjectKey, string $finalObjectKey, string $sessionId, string $nookId, array $file): void
    {
        $stmt = $pdo->prepare(
            "insert into global.file_uploads (id, note_id, nook_id, created_by, temp_object_key, final_object_key, session_id, expires_at, filename, extension, mime_type, expected_filesize, expected_checksum) "
            . "values (:id, :note_id, :nook_id, :created_by, :temp_object_key, :final_object_key, :session_id, now() + interval '15 minutes', :filename, :extension, :mime_type, :expected_filesize, :expected_checksum)"
        );
        $stmt->execute([
            ':id' => $uploadId,
            ':note_id' => $noteId,
            ':nook_id' => $nookId,
            ':created_by' => $userId,
            ':temp_object_key' => $tempObjectKey,
            ':final_object_key' => $finalObjectKey,
            ':session_id' => $sessionId !== '' ? $sessionId : null,
            ':filename' => $file['filename'],
            ':extension' => $file['extension'],
            ':mime_type' => $file['mime_type'],
            ':expected_filesize' => $file['filesize'],
            ':expected_checksum' => $file['checksum'],
        ]);
    }

    /**
     * Set the note attribute to just the file_version pointer.
     */
    private function updateNoteFileAttribute(PDO $pdo, string $noteId, string $nookId, string $attributeId, int $fileVersion): void
    {
        $attrValue = ['file_version' => $fileVersion];

        $stmt = $pdo->prepare(
            "update global.notes set attributes = jsonb_set(coalesce(attributes, '{}'), :path::text[], :value::jsonb), updated_at = now() "
            . "where id = :id and nook_id = :nook_id"
        );
        $stmt->execute([
            ':path' => '{' . $attributeId . '}',
            ':value' => json_encode($attrValue),
            ':id' => $noteId,
            ':nook_id' => $nookId,
        ]);
    }

    /** @return array{temp_object_key: string, final_object_key: string} */
    private function lockUpload(PDO $pdo, string $uploadId, string $noteId, string $userId, string $sessionId): array
    {
        $stmt = $pdo->prepare(
            "select temp_object_key, final_object_key, session_id, put_claimed_at "
            . "from global.file_uploads "
            . "where id = :id and note_id = :note_id and created_by = :created_by and finalized_at is null and expires_at > now() "
            . "for update"
        );
        $stmt->execute([':id' => $uploadId, ':note_id' => $noteId, ':created_by' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('upload not found', 404);
        }

        $tempObjectKey = Row::str($row, 'temp_object_key');
        $finalObjectKey = Row::str($row, 'final_object_key');
        $uploadSessionId = is_scalar($row['session_id'] ?? null) ? trim((string)$row['session_id']) : '';
        $putClaimedAt = $row['put_claimed_at'] ?? null;

        if ($tempObjectKey === '' || $finalObjectKey === '') {
            throw new HttpError('upload invalid', 500);
        }
        if (!is_scalar($putClaimedAt) || trim((string)$putClaimedAt) === '') {
            throw new HttpError('upload not complete', 409);
        }
        if ($uploadSessionId !== '' && ($sessionId === '' || $sessionId !== $uploadSessionId)) {
            throw new HttpError('not authorized', 403);
        }

        return ['temp_object_key' => $tempObjectKey, 'final_object_key' => $finalObjectKey];
    }

    private function validateAndMoveFile(PDO $pdo, string $noteId, string $tempObjectKey, string $finalObjectKey): void
    {
        $from = self::dataPath() . '/' . ltrim($tempObjectKey, '/');
        $to = self::dataPath() . '/' . ltrim($finalObjectKey, '/');

        if (!file_exists($from)) {
            throw new HttpError('temp upload missing', 404);
        }

        $dir = dirname($to);
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0777, true) && !is_dir($dir)) {
                throw new HttpError('failed to create final dir', 500);
            }
        }

        if (!rename($from, $to)) {
            throw new HttpError('failed to finalize upload', 500);
        }
    }

    private function requireNoteWriteAccess(PDO $pdo, NookRole $role, string $userId, string $noteId, string $nookId): void
    {
        if ($role === NookRole::Owner) {
            return;
        }
        $c = $pdo->prepare('select created_by from global.notes where id = :id and nook_id = :nook_id');
        $c->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $createdBy = $c->fetchColumn();
        if (!is_scalar($createdBy) || (string)$createdBy !== $userId) {
            throw new HttpError('forbidden', 403);
        }
    }

    private function requireMember(PDO $pdo, User $user, string $nookId): void
    {
        $userId = $user->id;
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }
        $check = $pdo->prepare('select 1 from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([':nook_id' => $nookId, ':user_id' => $userId]);
        if (!$check->fetch()) {
            throw new HttpError('forbidden', 403);
        }
    }

    private function generateUuid(PDO $pdo): string
    {
        $stmt = $pdo->query('select gen_random_uuid()');
        $raw = $stmt !== false ? $stmt->fetchColumn() : null;
        $id = is_scalar($raw) ? (string)$raw : '';
        if ($id === '') {
            throw new HttpError('failed to allocate UUID', 500);
        }
        return $id;
    }

    private function extractSessionId(Request $request): string
    {
        $cookieHeader = $request->header('Cookie');
        $cookies = $cookieHeader !== '' ? Cookies::parseCookieHeader($cookieHeader) : [];
        $sid = $cookies[SessionStore::cookieName()] ?? '';
        $sid = trim($sid);
        if ($sid !== '' && !Uuid::isValid($sid)) {
            return '';
        }
        return $sid;
    }

    /** @param array<string, string> $query */
    private function filePublicUrlForRequest(Request $request, string $objectKey, array $query = []): string
    {
        $envBase = trim((string)getenv('PUBLIC_BASE_URL'));
        if ($envBase !== '') {
            $base = rtrim($envBase, '/');
        } else {
            $host = trim($request->header('X-Forwarded-Host'));
            if ($host === '') {
                $host = trim($request->header('Host'));
            }
            $proto = trim($request->header('X-Forwarded-Proto'));
            if ($proto === '') {
                $proto = 'http';
            }
            if ($host === '') {
                $host = 'localhost:8000';
            }
            $base = $proto . '://' . $host;
        }
        $path = '/files/' . ltrim($objectKey, '/');

        $q = [];
        foreach ($query as $k => $v) {
            $k = trim($k);
            if ($k === '' || $v === '') {
                continue;
            }
            $q[] = rawurlencode($k) . '=' . rawurlencode(trim($v));
        }

        return $q === [] ? $base . $path : $base . $path . '?' . implode('&', $q);
    }

    private static function dataPath(): string
    {
        $path = trim((string)getenv('FILES_DATA_PATH'));
        return $path !== '' ? rtrim($path, '/') : '/data';
    }

    private static function requireUuid(mixed $value, string $name): string
    {
        if (!is_string($value)) {
            throw new HttpError($name . ' is required', 400);
        }
        $v = trim($value);
        if ($v === '') {
            throw new HttpError($name . ' is required', 400);
        }
        if (!Uuid::isValid($v)) {
            throw new HttpError($name . ' must be a UUID', 400);
        }
        return $v;
    }

    private static function requireUserId(User $user): string
    {
        $userId = $user->id;
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }
        return $userId;
    }
}
