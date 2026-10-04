<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\User;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Service\Files\LocalObjectStore;
use Paith\Notes\Api\Http\Service\Images\ImageBytes;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Throwable;

/**
 * POST /api/nooks/{nookId}/chat-images
 *
 * Persist an image the user attached to a chat message (base64) as a
 * note file — either a NEW file-typed note, or a NEW VERSION attached to an
 * EXISTING note. This is the backend half of "the model saves a pasted
 * image as a note". The MCP tool save_image_to_note posts the ORIGINAL,
 * un-resized bytes here (vision-path resizing only applies to what's sent
 * to the model, never to what's stored).
 *
 * Mirrors AiImagesController's persistence scheme (write bytes to disk,
 * insert note + note_files row, bootstrap the `file` type + file attribute)
 * so the result is indistinguishable from any other uploaded asset.
 */
final class ChatImagesController
{
    private const FILE_TYPE_KEY = 'file';
    private const FILE_ATTRIBUTE_NAME = 'File';
    private const FILE_ATTRIBUTE_KIND = 'file';
    private const TITLE_MAX_LEN = 80;

    /**
     * Store a chat attachment as a note by COPYING the bytes already on disk.
     *
     * Preferred over re-posting base64: the attachment was uploaded once when
     * the user pasted it, so this path moves zero bytes through the MCP process
     * and keeps the original full resolution (no resize, no re-encode).
     */
    public function saveFromAttachment(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookIdParam = trim($request->routeParam('nookId'));
        if ($nookIdParam === '') {
            throw new HttpError('nookId is required', 400);
        }
        $nookId = $this->resolveNookId($pdo, $user, $nookIdParam);
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $body = $request->jsonBody();
        $attachmentId = $this->optionalString($body, 'attachment_id');
        if ($attachmentId === '') {
            throw new HttpError('attachment_id is required', 400);
        }

        // Ownership: the attachment must belong to one of the caller's
        // conversations. Never trust a bare uuid from the model.
        $stmt = $pdo->prepare(
            'select ci.object_key, ci.filename, ci.media_type
             from global.conversation_images ci
             join global.conversations c on c.id = ci.conversation_id
             where ci.id = :id and c.user_id = :user_id
             limit 1'
        );
        $stmt->execute([':id' => $attachmentId, ':user_id' => $user->id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('attachment not found', 404);
        }

        $objectKey = Row::str($row, 'object_key');
        $mimeType = Row::str($row, 'media_type');
        $filename = $this->optionalString($body, 'filename');
        if ($filename === '') {
            $filename = Row::str($row, 'filename', 'image.' . ImageBytes::extensionFor($mimeType));
        }
        if (!ImageBytes::isSupportedMime($mimeType)) {
            throw new HttpError('attachment is not a supported image type', 400);
        }

        $bytes = LocalObjectStore::read($objectKey);
        $extension = ImageBytes::extensionFor($mimeType);

        $noteId = $this->optionalString($body, 'note_id');
        $title = $this->optionalString($body, 'title');
        if ($noteId !== '') {
            return $this->attachToExistingNote($pdo, $user, $nookId, $noteId, $bytes, $mimeType, $extension, $filename);
        }
        return $this->createNewNote($pdo, $user, $nookId, $bytes, $mimeType, $extension, $filename, $title);
    }

    public function save(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();

        $nookIdParam = trim($request->routeParam('nookId'));
        if ($nookIdParam === '') {
            throw new HttpError('nookId is required', 400);
        }
        $nookId = $this->resolveNookId($pdo, $user, $nookIdParam);
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $body = $request->jsonBody();

        $base64 = ImageBytes::requireBase64($body, 'image_data', ['data']);
        // The declared media_type is deliberately ignored: only the bytes decide,
        // so a mislabelled or non-image payload can't become a note file that
        // claims to be a picture (see ImageBytes::resolveMime).
        $mimeType = ImageBytes::resolveMime($base64);
        if ($mimeType === null) {
            throw new HttpError('unsupported or undetectable image type (need png/jpeg/gif/webp)', 400);
        }
        $extension = ImageBytes::extensionFor($mimeType);
        $bytes = ImageBytes::decode($base64);

        $title = $this->optionalString($body, 'title');
        $noteId = $this->optionalString($body, 'note_id');
        $filename = $this->optionalString($body, 'filename');
        if ($filename === '') {
            $filename = 'image.' . $extension;
        }

        if ($noteId !== '') {
            return $this->attachToExistingNote($pdo, $user, $nookId, $noteId, $bytes, $mimeType, $extension, $filename);
        }

        return $this->createNewNote($pdo, $user, $nookId, $bytes, $mimeType, $extension, $filename, $title);
    }

    /**
     * Create a new file-typed note carrying the image.
     */
    private function createNewNote(
        PDO $pdo,
        User $user,
        string $nookId,
        string $bytes,
        string $mimeType,
        string $extension,
        string $filename,
        ?string $title,
    ): Response {
        $userId = $user->id;
        try {
            $pdo->beginTransaction();

            [$typeId, $fileAttributeId] = $this->ensureFileTypeAndAttribute($pdo, $nookId);

            $genStmt = $pdo->query('select gen_random_uuid()::text');
            $genId = $genStmt !== false ? $genStmt->fetchColumn() : null;
            $newNoteId = is_string($genId) ? trim($genId) : '';
            if ($newNoteId === '') {
                throw new HttpError('failed to generate note id', 500);
            }

            $fileVersion = 1;
            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $newNoteId, $fileAttributeId, $fileVersion);
            $resolvedTitle = $this->buildTitle($title ?? '', $filename);

            $noteStmt = $pdo->prepare(
                "insert into global.notes (id, nook_id, created_by, title, content, type_id, attributes) "
                . "values (:id, :nook_id, :created_by, :title, :content, :type_id, :attributes::jsonb) "
                . "returning created_at"
            );
            $noteStmt->execute([
                ':id' => $newNoteId,
                ':nook_id' => $nookId,
                ':created_by' => $userId,
                ':title' => $resolvedTitle,
                ':content' => '',
                ':type_id' => $typeId,
                ':attributes' => json_encode([$fileAttributeId => ['file_version' => $fileVersion]]),
            ]);
            $noteRow = $noteStmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($noteRow)) {
                throw new HttpError('failed to create note', 500);
            }
            $createdAt = Row::str($noteRow, 'created_at');

            $this->writeBytesToDisk($objectKey, $bytes);

            $pdo->prepare(
                "insert into global.note_files (note_id, attribute_id, object_key, filename, extension, filesize, mime_type, checksum, file_version, uploaded_by, nook_id, updated_at) "
                . "values (:note_id, :attribute_id, :object_key, :filename, :extension, :filesize, :mime_type, :checksum, :file_version, :uploaded_by, :nook_id, now())"
            )->execute([
                ':note_id' => $newNoteId,
                ':attribute_id' => $fileAttributeId,
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => strlen($bytes),
                ':mime_type' => $mimeType,
                ':checksum' => hash('sha256', $bytes),
                ':file_version' => $fileVersion,
                ':uploaded_by' => $userId,
                ':nook_id' => $nookId,
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'mode' => 'new_note',
                'note' => [
                    'id' => $newNoteId,
                    'nook_id' => $nookId,
                    'title' => $resolvedTitle,
                    'type_id' => $typeId,
                    'created_at' => $createdAt,
                ],
                'file' => [
                    'object_key' => $objectKey,
                    'filename' => $filename,
                    'extension' => $extension,
                    'filesize' => strlen($bytes),
                    'mime_type' => $mimeType,
                    'file_version' => $fileVersion,
                ],
                'embed' => "![{$resolvedTitle}](note:{$newNoteId})",
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Attach the image as a NEW VERSION on an existing note. Requires the
     * note to already have a file attribute (i.e. be a file/image note);
     * otherwise we 400 so the caller falls back to creating a new note.
     */
    private function attachToExistingNote(
        PDO $pdo,
        User $user,
        string $nookId,
        string $noteId,
        string $bytes,
        string $mimeType,
        string $extension,
        string $filename,
    ): Response {
        $userId = $user->id;
        try {
            $pdo->beginTransaction();

            $noteStmt = $pdo->prepare(
                'select n.id, n.nook_id, n.type_id from global.notes n where n.id = :id limit 1'
            );
            $noteStmt->execute([':id' => $noteId]);
            $noteRow = $noteStmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($noteRow)) {
                throw new HttpError('note not found', 404);
            }
            if (Row::str($noteRow, 'nook_id') !== $nookId) {
                throw new HttpError('note is not in this nook', 400);
            }
            $typeId = Row::str($noteRow, 'type_id');

            $fileRowStmt = $pdo->prepare(
                'select attribute_id, file_version from global.note_files where note_id = :nid limit 1'
            );
            $fileRowStmt->execute([':nid' => $noteId]);
            $fileRow = $fileRowStmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($fileRow)) {
                throw new HttpError('note has no attached file — create a new note instead', 400);
            }
            $fileAttributeId = Row::str($fileRow, 'attribute_id');
            $newVersion = Row::int($fileRow, 'file_version', 1) + 1;

            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $fileAttributeId, $newVersion);
            $this->writeBytesToDisk($objectKey, $bytes);

            // global.note_files is keyed by note_id (PRIMARY KEY) — exactly ONE
            // row per note — so a new version replaces the row in place rather
            // than inserting a second one. Mirrors AiImagesController.
            $pdo->prepare(
                'update global.note_files set '
                . '  object_key = :object_key, '
                . '  filename = :filename, '
                . '  extension = :extension, '
                . '  filesize = :filesize, '
                . '  mime_type = :mime_type, '
                . '  checksum = :checksum, '
                . '  file_version = :file_version, '
                . '  uploaded_by = :uploaded_by, '
                . '  updated_at = now() '
                . 'where note_id = :note_id and attribute_id = :attribute_id'
            )->execute([
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => strlen($bytes),
                ':mime_type' => $mimeType,
                ':checksum' => hash('sha256', $bytes),
                ':file_version' => $newVersion,
                ':uploaded_by' => $userId,
                ':note_id' => $noteId,
                ':attribute_id' => $fileAttributeId,
            ]);

            // Move the note's file_version attribute pointer forward so the UI
            // renders the image we just wrote instead of the previous version.
            // Mirrors the attributes rewrite in AiImagesController.
            $attrsStmt = $pdo->prepare('select attributes from global.notes where id = :id limit 1');
            $attrsStmt->execute([':id' => $noteId]);
            $attrsRow = $attrsStmt->fetch(PDO::FETCH_ASSOC);
            $attrs = is_array($attrsRow)
                ? Row::decodeJsonObject($attrsRow['attributes'] ?? null)
                : [];
            $attrs[$fileAttributeId] = ['file_version' => $newVersion];

            $pdo->prepare(
                'update global.notes set attributes = :attributes::jsonb, updated_at = now() '
                . 'where id = :id and nook_id = :nook_id'
            )->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':attributes' => json_encode($attrs),
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'mode' => 'attached',
                'note' => [
                    'id' => $noteId,
                    'nook_id' => $nookId,
                    'type_id' => $typeId,
                ],
                'file' => [
                    'attribute_id' => $fileAttributeId,
                    'object_key' => $objectKey,
                    'filename' => $filename,
                    'extension' => $extension,
                    'filesize' => strlen($bytes),
                    'mime_type' => $mimeType,
                    'file_version' => $newVersion,
                ],
                'embed' => "![image](note:{$noteId})",
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    // ─── Input helpers ─────────────────────────────────────────────────

    /**
     * @param array<string, mixed> $body
     */
    private function optionalString(array $body, string $key): string
    {
        $v = $body[$key] ?? null;
        return is_string($v) ? trim($v) : '';
    }

    // ─── Persistence helpers (mirror AiImagesController) ───────────────

    private function resolveNookId(PDO $pdo, User $user, string $nookIdOrAlias): string
    {
        if ($nookIdOrAlias === 'ai-memory') {
            $stmt = $pdo->prepare(
                "select n.id from global.nooks n "
                . "join global.nook_members nm on nm.nook_id = n.id "
                . "where nm.user_id = :user_id and n.purpose = 'ai-memory' limit 1"
            );
            $stmt->execute([':user_id' => $user->id]);
            $id = $stmt->fetchColumn();
            if (!is_string($id) || $id === '') {
                throw new HttpError('AI memory nook not found', 404);
            }
            return $id;
        }
        return $nookIdOrAlias;
    }

    /**
     * @return array{0: string, 1: string} [typeId, fileAttributeId]
     */
    private function ensureFileTypeAndAttribute(PDO $pdo, string $nookId): array
    {
        $typeId = $this->lookupFileType($pdo, $nookId);
        if ($typeId === '') {
            $baseTypeId = $this->lookupBaseType($pdo, $nookId);
            $stmt = $pdo->prepare(
                'insert into global.note_types (nook_id, key, label, parent_id) '
                . 'values (:nook_id, :key, :label, :parent_id) '
                . 'on conflict (nook_id, key) do nothing '
                . 'returning id'
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':key' => self::FILE_TYPE_KEY,
                ':label' => 'File',
                ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
            ]);
            $newId = $stmt->fetchColumn();
            $typeId = is_string($newId) && $newId !== '' ? $newId : $this->lookupFileType($pdo, $nookId);
            if ($typeId === '') {
                throw new HttpError('failed to bootstrap file note type', 500);
            }
        }

        $attributeId = $this->lookupFileAttribute($pdo, $nookId, $typeId);
        if ($attributeId === '') {
            $stmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, :name, :kind, '{\"display\": \"preview\"}'::jsonb) "
                . "on conflict do nothing "
                . "returning id"
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':name' => self::FILE_ATTRIBUTE_NAME,
                ':kind' => self::FILE_ATTRIBUTE_KIND,
            ]);
            $newId = $stmt->fetchColumn();
            $attributeId = is_string($newId) && $newId !== '' ? $newId : $this->lookupFileAttribute($pdo, $nookId, $typeId);
            if ($attributeId === '') {
                throw new HttpError('failed to bootstrap file attribute', 500);
            }
        }

        return [$typeId, $attributeId];
    }

    private function lookupFileType(PDO $pdo, string $nookId): string
    {
        $stmt = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $stmt->execute([':nook_id' => $nookId, ':key' => self::FILE_TYPE_KEY]);
        $id = $stmt->fetchColumn();
        return is_string($id) ? $id : '';
    }

    private function lookupBaseType(PDO $pdo, string $nookId): string
    {
        $stmt = $pdo->prepare("select id from global.note_types where nook_id = :nook_id and key = 'base'");
        $stmt->execute([':nook_id' => $nookId]);
        $id = $stmt->fetchColumn();
        return is_string($id) ? $id : '';
    }

    private function lookupFileAttribute(PDO $pdo, string $nookId, string $typeId): string
    {
        $stmt = $pdo->prepare(
            'select id from global.type_attributes '
            . 'where nook_id = :nook_id and type_id = :type_id and kind = :kind limit 1'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':type_id' => $typeId,
            ':kind' => self::FILE_ATTRIBUTE_KIND,
        ]);
        $id = $stmt->fetchColumn();
        return is_string($id) ? $id : '';
    }

    private function writeBytesToDisk(string $objectKey, string $bytes): void
    {
        LocalObjectStore::write($objectKey, $bytes);
    }

    private function buildTitle(string $requested, string $filename): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', $requested) ?? '');
        if ($clean !== '' && strlen($clean) <= self::TITLE_MAX_LEN) {
            return $clean;
        }
        if ($clean !== '') {
            return rtrim(substr($clean, 0, self::TITLE_MAX_LEN - 1)) . '…';
        }
        // Fall back to a filename minus extension, else a generic label.
        $base = pathinfo($filename, PATHINFO_FILENAME);
        $base = trim(preg_replace('/\s+/', ' ', $base) ?? '');
        if ($base !== '' && strlen($base) <= self::TITLE_MAX_LEN) {
            return $base;
        }
        if ($base !== '') {
            return rtrim(substr($base, 0, self::TITLE_MAX_LEN - 1)) . '…';
        }
        return 'Image';
    }
}
