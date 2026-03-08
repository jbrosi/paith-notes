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
use PDO;
use Throwable;

final class FileNotesController
{
    private const NOTE_TYPE_FILE = 'file';

    public function fileUploadUrl(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $cookieHeader = $request->header('Cookie');
        $cookies = $cookieHeader !== '' ? Cookies::parseCookieHeader($cookieHeader) : [];
        $sessionIdRaw = $cookies[SessionStore::cookieName()] ?? '';
        $sessionId = trim($sessionIdRaw);
        if ($sessionId !== '' && !$this->isUuid($sessionId)) {
            $sessionId = '';
        }

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!$this->isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!$this->isUuid($noteId)) {
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
        $uploadIdStmt = $pdo->query('select gen_random_uuid()');
        $uploadIdRaw = $uploadIdStmt !== false ? $uploadIdStmt->fetchColumn() : null;
        $uploadId = is_scalar($uploadIdRaw) ? (string)$uploadIdRaw : '';
        if ($uploadId === '') {
            throw new HttpError('failed to allocate upload id', 500);
        }

        $tempObjectKey = 'tmp/' . $uploadId;
        $url = $this->filePublicUrlForRequest($request, $tempObjectKey);

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

            $insUpload = $pdo->prepare(
                "insert into global.file_uploads (id, note_id, created_by, temp_object_key, final_object_key, session_id, expires_at)\n"
                . "values (:id, :note_id, :created_by, :temp_object_key, :final_object_key, :session_id, now() + interval '15 minutes')"
            );
            $insUpload->execute([
                ':id' => $uploadId,
                ':note_id' => $noteId,
                ':created_by' => $userId,
                ':temp_object_key' => $tempObjectKey,
                ':final_object_key' => $objectKey,
                ':session_id' => $sessionId !== '' ? $sessionId : null,
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
                ':properties' => $this->encodeJsonObject($properties),
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
            'upload_id' => $uploadId,
            'temp_object_key' => $tempObjectKey,
            'object_key' => $objectKey,
            'expires_in' => 0,
        ]);
    }

    public function fileUploadUrlInit(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $cookieHeader = $request->header('Cookie');
        $cookies = $cookieHeader !== '' ? Cookies::parseCookieHeader($cookieHeader) : [];
        $sessionIdRaw = $cookies[SessionStore::cookieName()] ?? '';
        $sessionId = trim($sessionIdRaw);
        if ($sessionId !== '' && !$this->isUuid($sessionId)) {
            $sessionId = '';
        }

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!$this->isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
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

        $uploadIdStmt = $pdo->query('select gen_random_uuid()');
        $uploadIdRaw = $uploadIdStmt !== false ? $uploadIdStmt->fetchColumn() : null;
        $uploadId = is_scalar($uploadIdRaw) ? (string)$uploadIdRaw : '';
        if ($uploadId === '') {
            throw new HttpError('failed to allocate upload id', 500);
        }

        $tempObjectKey = 'tmp/' . $uploadId;
        $url = $this->filePublicUrlForRequest($request, $tempObjectKey);

        $insUpload = $pdo->prepare(
            "insert into global.file_uploads (id, nook_id, created_by, temp_object_key, session_id, expires_at, filename, extension, mime_type, expected_filesize, expected_checksum)\n"
            . "values (:id, :nook_id, :created_by, :temp_object_key, :session_id, now() + interval '15 minutes', :filename, :extension, :mime_type, :expected_filesize, :expected_checksum)"
        );
        $insUpload->execute([
            ':id' => $uploadId,
            ':nook_id' => $nookId,
            ':created_by' => $userId,
            ':temp_object_key' => $tempObjectKey,
            ':session_id' => $sessionId !== '' ? $sessionId : null,
            ':filename' => $filename,
            ':extension' => $extension,
            ':mime_type' => $mimeType,
            ':expected_filesize' => $filesize,
            ':expected_checksum' => $checksum,
        ]);

        return JsonResponse::ok([
            'upload_url' => $url,
            'upload_id' => $uploadId,
            'temp_object_key' => $tempObjectKey,
            'expires_in' => 0,
        ]);
    }

    public function fileFinalizeCreateNote(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $cookieHeader = $request->header('Cookie');
        $cookies = $cookieHeader !== '' ? Cookies::parseCookieHeader($cookieHeader) : [];
        $sessionIdRaw = $cookies[SessionStore::cookieName()] ?? '';
        $sessionId = trim($sessionIdRaw);

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!$this->isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $data = $request->jsonBody();
        $uploadIdRaw = $data['upload_id'] ?? '';
        $uploadId = is_string($uploadIdRaw) ? trim($uploadIdRaw) : '';
        if ($uploadId === '') {
            throw new HttpError('upload_id is required', 400);
        }
        if (!$this->isUuid($uploadId)) {
            throw new HttpError('upload_id must be a UUID', 400);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                "select nook_id, temp_object_key, session_id, put_claimed_at, filename, extension, mime_type, expected_filesize, expected_checksum\n"
                . "from global.file_uploads\n"
                . "where id = :id and created_by = :created_by and finalized_at is null and expires_at > now()\n"
                . "for update"
            );
            $stmt->execute([
                ':id' => $uploadId,
                ':created_by' => $userId,
            ]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('upload not found', 404);
            }

            $uploadNookId = is_scalar($row['nook_id'] ?? null) ? (string)$row['nook_id'] : '';
            if ($uploadNookId !== $nookId) {
                throw new HttpError('not found', 404);
            }

            $tempObjectKey = is_scalar($row['temp_object_key'] ?? null) ? (string)$row['temp_object_key'] : '';
            $uploadSessionId = is_scalar($row['session_id'] ?? null) ? trim((string)$row['session_id']) : '';
            $putClaimedAt = $row['put_claimed_at'] ?? null;
            if ($tempObjectKey === '') {
                throw new HttpError('upload invalid', 500);
            }

            if (!is_scalar($putClaimedAt) || trim((string)$putClaimedAt) === '') {
                throw new HttpError('upload not complete', 409);
            }

            if ($uploadSessionId !== '') {
                if ($sessionId === '' || $sessionId !== $uploadSessionId) {
                    throw new HttpError('not authorized', 403);
                }
            }

            $filename = is_scalar($row['filename'] ?? null) ? trim((string)$row['filename']) : '';
            if ($filename === '') {
                $filename = 'upload';
            }
            $extension = is_scalar($row['extension'] ?? null) ? trim((string)$row['extension']) : '';
            $mimeType = is_scalar($row['mime_type'] ?? null) ? trim((string)$row['mime_type']) : '';
            $expectedFilesizeRaw = $row['expected_filesize'] ?? 0;
            $expectedFilesize = is_numeric($expectedFilesizeRaw) ? (int)$expectedFilesizeRaw : 0;
            $expectedChecksumRaw = $row['expected_checksum'] ?? '';
            $expectedChecksum = is_scalar($expectedChecksumRaw) ? trim((string)$expectedChecksumRaw) : '';

            $from = '/data/' . ltrim($tempObjectKey, '/');
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

            $noteStmt = $pdo->prepare(
                "insert into global.notes (nook_id, created_by, title, content, type, properties, former_properties)\n"
                . "values (:nook_id, :created_by, :title, :content, :type, :properties, :former_properties)\n"
                . "returning id, created_at"
            );

            $properties = [
                'filename' => $filename,
                'extension' => $extension,
                'filesize' => $serverFilesize,
                'mime_type' => $mimeType,
                'checksum' => $serverChecksum,
            ];

            $noteStmt->execute([
                ':nook_id' => $nookId,
                ':created_by' => $userId,
                ':title' => $filename,
                ':content' => '',
                ':type' => self::NOTE_TYPE_FILE,
                ':properties' => $this->encodeJsonObject($properties),
                ':former_properties' => '{}',
            ]);

            $noteRow = $noteStmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($noteRow)) {
                throw new HttpError('failed to create note', 500);
            }

            $noteIdRaw = $noteRow['id'] ?? '';
            $createdAtRaw = $noteRow['created_at'] ?? '';
            $noteId = is_scalar($noteIdRaw) ? (string)$noteIdRaw : '';
            if ($noteId === '') {
                throw new HttpError('failed to create note', 500);
            }

            $objectKey = sprintf('notes/%s/files/%s', $nookId, $noteId);
            $to = '/data/' . ltrim($objectKey, '/');
            $dir = dirname($to);
            if (!is_dir($dir)) {
                if (!mkdir($dir, 0777, true) && !is_dir($dir)) {
                    throw new HttpError('failed to create final dir', 500);
                }
            }

            if (!rename($from, $to)) {
                throw new HttpError('failed to finalize upload', 500);
            }

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
                ':filesize' => $serverFilesize,
                ':mime_type' => $mimeType,
                ':checksum' => $serverChecksum,
            ]);

            $updUpload = $pdo->prepare(
                'update global.file_uploads set note_id = :note_id, finalized_note_id = :note_id, final_object_key = :final_object_key, finalized_at = now() where id = :id and finalized_at is null'
            );
            $updUpload->execute([
                ':id' => $uploadId,
                ':note_id' => $noteId,
                ':final_object_key' => $objectKey,
            ]);
            if ($updUpload->rowCount() !== 1) {
                throw new HttpError('upload already finalized', 409);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => $noteId,
                    'nook_id' => $nookId,
                    'title' => $filename,
                    'content' => '',
                    'type' => self::NOTE_TYPE_FILE,
                    'properties' => $properties,
                    'former_properties' => (object)[],
                    'created_at' => is_scalar($createdAtRaw) ? (string)$createdAtRaw : '',
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

    public function fileFinalize(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $cookieHeader = $request->header('Cookie');
        $cookies = $cookieHeader !== '' ? Cookies::parseCookieHeader($cookieHeader) : [];
        $sessionIdRaw = $cookies[SessionStore::cookieName()] ?? '';
        $sessionId = trim($sessionIdRaw);

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!$this->isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!$this->isUuid($noteId)) {
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

        $data = $request->jsonBody();
        $uploadIdRaw = $data['upload_id'] ?? '';
        $uploadId = is_string($uploadIdRaw) ? trim($uploadIdRaw) : '';
        if ($uploadId === '') {
            throw new HttpError('upload_id is required', 400);
        }
        if (!$this->isUuid($uploadId)) {
            throw new HttpError('upload_id must be a UUID', 400);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                "select temp_object_key, final_object_key, session_id, put_claimed_at\n"
                . "from global.file_uploads\n"
                . "where id = :id and note_id = :note_id and created_by = :created_by and finalized_at is null and expires_at > now()\n"
                . "for update"
            );
            $stmt->execute([
                ':id' => $uploadId,
                ':note_id' => $noteId,
                ':created_by' => $userId,
            ]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('upload not found', 404);
            }

            $tempObjectKey = is_scalar($row['temp_object_key'] ?? null) ? (string)$row['temp_object_key'] : '';
            $finalObjectKey = is_scalar($row['final_object_key'] ?? null) ? (string)$row['final_object_key'] : '';
            $uploadSessionId = is_scalar($row['session_id'] ?? null) ? trim((string)$row['session_id']) : '';
            $putClaimedAt = $row['put_claimed_at'] ?? null;
            if ($tempObjectKey === '' || $finalObjectKey === '') {
                throw new HttpError('upload invalid', 500);
            }

            if (!is_scalar($putClaimedAt) || trim((string)$putClaimedAt) === '') {
                throw new HttpError('upload not complete', 409);
            }

            if ($uploadSessionId !== '') {
                if ($sessionId === '' || $sessionId !== $uploadSessionId) {
                    throw new HttpError('not authorized', 403);
                }
            }

            $from = '/data/' . ltrim($tempObjectKey, '/');
            $to = '/data/' . ltrim($finalObjectKey, '/');

            if (!file_exists($from)) {
                throw new HttpError('temp upload missing', 404);
            }

            $serverFilesize = @filesize($from);
            $serverFilesize = is_int($serverFilesize) ? max(0, $serverFilesize) : 0;

            $serverChecksum = @hash_file('sha256', $from);
            $serverChecksum = is_string($serverChecksum) ? trim($serverChecksum) : '';

            $dir = dirname($to);
            if (!is_dir($dir)) {
                if (!mkdir($dir, 0777, true) && !is_dir($dir)) {
                    throw new HttpError('failed to create final dir', 500);
                }
            }

            $expectedStmt = $pdo->prepare('select filesize, checksum from global.note_files where note_id = :note_id');
            $expectedStmt->execute([':note_id' => $noteId]);
            $expected = $expectedStmt->fetch(PDO::FETCH_ASSOC);
            if (is_array($expected)) {
                $expectedFilesizeRaw = $expected['filesize'] ?? 0;
                $expectedFilesize = is_numeric($expectedFilesizeRaw) ? (int)$expectedFilesizeRaw : 0;
                if ($expectedFilesize > 0 && $serverFilesize !== $expectedFilesize) {
                    throw new HttpError('upload incomplete (filesize mismatch)', 400);
                }

                $expectedChecksumRaw = $expected['checksum'] ?? '';
                $expectedChecksum = is_scalar($expectedChecksumRaw) ? trim((string)$expectedChecksumRaw) : '';
                if ($expectedChecksum !== '' && $serverChecksum !== '' && $serverChecksum !== $expectedChecksum) {
                    throw new HttpError('upload corrupted (checksum mismatch)', 400);
                }
            }

            if (!rename($from, $to)) {
                throw new HttpError('failed to finalize upload', 500);
            }

            $finalFilesize = $serverFilesize;
            $finalChecksum = $serverChecksum;

            $updFile = $pdo->prepare(
                'update global.note_files set filesize = :filesize, checksum = :checksum, updated_at = now() where note_id = :note_id'
            );
            $updFile->execute([
                ':filesize' => $finalFilesize,
                ':checksum' => $finalChecksum,
                ':note_id' => $noteId,
            ]);

            $props = $pdo->prepare('select properties from global.notes where id = :id and nook_id = :nook_id');
            $props->execute([':id' => $noteId, ':nook_id' => $nookId]);
            $existingPropsRaw = $props->fetchColumn();
            $existingProps = [];
            if (is_scalar($existingPropsRaw) && trim((string)$existingPropsRaw) !== '') {
                $decoded = json_decode((string)$existingPropsRaw, true);
                if (is_array($decoded)) {
                    $existingProps = $decoded;
                }
            }

            $existingProps['filesize'] = $finalFilesize;
            $existingProps['checksum'] = $finalChecksum;

            $updateProps = $pdo->prepare('update global.notes set properties = :properties where id = :id and nook_id = :nook_id');
            $updateProps->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':properties' => $this->encodeJsonObject($existingProps),
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

    public function fileDownloadUrl(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!$this->isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!$this->isUuid($noteId)) {
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
        $inline = trim($request->queryParam('inline')) !== '';

        $url = $this->filePublicUrlForRequest($request, $objectKey, [
            'inline' => $inline ? '1' : '',
        ]);

        return JsonResponse::ok([
            'download_url' => $url,
            'expires_in' => 0,
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
            if ($k === '') {
                continue;
            }
            $vStr = is_scalar($v) ? trim((string)$v) : '';
            if ($vStr === '') {
                continue;
            }
            $q[] = rawurlencode($k) . '=' . rawurlencode($vStr);
        }

        if ($q === []) {
            return $base . $path;
        }

        return $base . $path . '?' . implode('&', $q);
    }

    private function encodeJsonObject(array $value): string
    {
        if ($value === []) {
            return '{}';
        }
        $encoded = json_encode($value, JSON_UNESCAPED_SLASHES);
        return is_string($encoded) ? $encoded : '{}';
    }

    private function isUuid(string $value): bool
    {
        return (bool)preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value);
    }
}
