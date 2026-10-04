<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Service\Files\LocalObjectStore;
use Paith\Notes\Api\Http\Service\Images\ImageBytes;
use Paith\Notes\Api\Http\TextResponse;
use Paith\Notes\Shared\Db\Row;
use PDO;

/**
 * Chat attachments — the ORIGINAL bytes of images pasted into a chat message.
 *
 * Why this exists
 * ---------------
 * The conversation block only ever stores the DOWNSCALED copy (the ≤1024px
 * vision payload), because that is all the model was shown. Until this table
 * existed, the full-resolution original lived in an in-memory Map inside the MCP
 * process and was dropped the moment the turn ended — so "analyse this image,
 * then save it as a note" was impossible, and the model could never re-look at
 * a picture from an earlier turn.
 *
 * With a row + a file on disk, an attachment is addressable for the whole life
 * of the conversation:
 *   - the model can pull the pixels back into any later turn (look_at_image),
 *   - saving it to a note is a server-side copy at full resolution,
 *   - the UI can render the original after a reload.
 *
 * Lifetime
 * --------
 * Rows cascade away with the conversation (delete one, or delete all). The bytes
 * are unlinked explicitly by ConversationsController, since a DB cascade can't
 * reach the filesystem. `attachment_index` is append-only for the life of the
 * conversation, so `[IMAGE n]` always names the same picture.
 */
final class ChatAttachmentsController
{
    /** Cap on images accepted in one call (mirrors MAX_CHAT_IMAGES in MCP). */
    private const MAX_PER_REQUEST = 4;

    /** Cap on how many attachments one conversation may accumulate. Bounds the
     *  worst case (a long conversation with many pastes) until a retention
     *  policy lands; the conversation dies well before this in normal use. */
    private const MAX_PER_CONVERSATION = 200;

    /**
     * POST /api/conversations/{conversationId}/images
     *
     * Body: { images: [{ data, media_type?, filename? }, …], turn_id?, nook_id? }
     * `data` is a bare base64 string or a data: URI holding the ORIGINAL bytes.
     * Returns one row per stored image, each with the durable `id` the model
     * passes back to look_at_image / save_image_to_note.
     */
    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $userId = $context->userId();
        $conversationId = $request->requireUuidRouteParam('conversationId');
        $this->requireOwnedConversation($pdo, $userId, $conversationId);

        $body = $request->jsonBody();
        $rawImages = $body['images'] ?? null;
        if (!is_array($rawImages) || $rawImages === []) {
            throw new HttpError('images (non-empty array) is required', 400);
        }
        if (count($rawImages) > self::MAX_PER_REQUEST) {
            throw new HttpError('too many images in one message (max ' . self::MAX_PER_REQUEST . ')', 400);
        }
        /** @var list<array<string, mixed>> $images */
        $images = [];
        foreach (array_values($rawImages) as $offset => $raw) {
            if (!is_array($raw)) {
                throw new HttpError('images[' . $offset . '] must be an object', 400);
            }
            /** @var array<string, mixed> $raw */
            $images[] = $raw;
        }

        $turnId = $this->optionalUuid($body, 'turn_id');
        $nookId = $this->optionalUuid($body, 'nook_id');

        // Reserve the whole batch up front so attachment_index never collides
        // and a partially-failed batch doesn't leave holes in the numbering.
        $nextIndex = $this->reserveIndexes($pdo, $conversationId, count($images));

        $stored = [];
        $writtenKeys = [];
        // Rows and bytes have to land together or not at all: a half-stored
        // batch would leave rows pointing at files that were just unlinked (and
        // a file with no row is an orphan nothing ever collects).
        $pdo->beginTransaction();
        try {
            foreach ($images as $offset => $raw) {
                $base64 = ImageBytes::requireBase64($raw, 'data', ['image_data']);
                // The declared media_type is deliberately ignored: only the bytes
                // decide, so a mislabelled or non-image payload can't be stored as
                // a picture (see ImageBytes::resolveMime).
                $mimeType = ImageBytes::resolveMime($base64);
                if ($mimeType === null) {
                    throw new HttpError('unsupported or undetectable image type (need png/jpeg/gif/webp)', 400);
                }
                $bytes = ImageBytes::decode($base64);
                $extension = ImageBytes::extensionFor($mimeType);

                $attachmentIndex = $nextIndex + $offset;
                $filename = $this->optionalString($raw, 'filename');
                if ($filename === '') {
                    $filename = 'image.' . $extension;
                }

                $genStmt = $pdo->query('select gen_random_uuid()::text');
                $genId = $genStmt !== false ? $genStmt->fetchColumn() : null;
                $imageId = is_string($genId) ? trim($genId) : '';
                if ($imageId === '') {
                    throw new HttpError('failed to generate attachment id', 500);
                }

                // Same path shape as note files, so the files sidecar and any
                // backup covers chat attachments the same way.
                $objectKey = sprintf(
                    'chat/%s/images/%s.%s',
                    $conversationId,
                    $imageId,
                    $extension
                );
                LocalObjectStore::write($objectKey, $bytes);
                $writtenKeys[] = $objectKey;

                $stmt = $pdo->prepare(
                    'insert into global.conversation_images '
                    . ' (id, conversation_id, turn_id, nook_id, attachment_index, filename, media_type, filesize, checksum, object_key) '
                    . 'values (:id, :conversation_id, :turn_id, :nook_id, :attachment_index, :filename, :media_type, :filesize, :checksum, :object_key)'
                );
                $stmt->execute([
                    ':id' => $imageId,
                    ':conversation_id' => $conversationId,
                    ':turn_id' => $turnId,
                    ':nook_id' => $nookId,
                    ':attachment_index' => $attachmentIndex,
                    ':filename' => $filename,
                    ':media_type' => $mimeType,
                    ':filesize' => strlen($bytes),
                    ':checksum' => hash('sha256', $bytes),
                    ':object_key' => $objectKey,
                ]);

                $stored[] = [
                    'id' => $imageId,
                    'attachment_index' => $attachmentIndex,
                    'filename' => $filename,
                    'media_type' => $mimeType,
                    'filesize' => strlen($bytes),
                    'checksum' => hash('sha256', $bytes),
                ];
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            // Roll the rows back and unlink whatever we already wrote, so a
            // rejected batch leaves neither a row nor an orphaned file.
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            foreach ($writtenKeys as $key) {
                LocalObjectStore::delete($key);
            }
            throw $e;
        }

        return JsonResponse::ok([
            'conversation_id' => $conversationId,
            'images' => $stored,
        ]);
    }

    /**
     * GET /api/conversations/{conversationId}/images
     *
     * Metadata for every attachment in the conversation (no bytes). Lets the
     * frontend re-render a reloaded chat and lets the model discover what is
     * available before asking to look at something.
     */
    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $conversationId = $request->requireUuidRouteParam('conversationId');
        $this->requireOwnedConversation($pdo, $context->userId(), $conversationId);

        $stmt = $pdo->prepare(
            'select id, attachment_index, filename, media_type, filesize, turn_id, nook_id, created_at '
            . 'from global.conversation_images where conversation_id = :conversation_id '
            . 'order by attachment_index asc'
        );
        $stmt->execute([':conversation_id' => $conversationId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $images = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $images[] = [
                'id' => Row::str($row, 'id'),
                'attachment_index' => Row::int($row, 'attachment_index', 0),
                'filename' => Row::str($row, 'filename'),
                'media_type' => Row::str($row, 'media_type'),
                'filesize' => Row::int($row, 'filesize', 0),
                'turn_id' => Row::str($row, 'turn_id'),
                'nook_id' => Row::str($row, 'nook_id'),
                'created_at' => Row::str($row, 'created_at'),
            ];
        }

        return JsonResponse::ok(['conversation_id' => $conversationId, 'images' => $images]);
    }

    /**
     * GET /api/conversations/{conversationId}/images/{imageId}
     *
     * The ORIGINAL bytes, as a binary body with the stored mime type. This is
     * what look_at_image fetches before handing the pixels to the model, and
     * what the UI can use to show the full-resolution original after a reload.
     */
    public function read(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $conversationId = $request->requireUuidRouteParam('conversationId');
        $imageId = $request->requireUuidRouteParam('imageId');
        $this->requireOwnedConversation($pdo, $context->userId(), $conversationId);

        $stmt = $pdo->prepare(
            'select object_key, filename, media_type, filesize '
            . 'from global.conversation_images '
            . 'where id = :id and conversation_id = :conversation_id limit 1'
        );
        $stmt->execute([':id' => $imageId, ':conversation_id' => $conversationId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('attachment not found', 404);
        }

        $mimeType = Row::str($row, 'media_type', 'application/octet-stream');
        $filename = Row::str($row, 'filename', 'image');
        $bytes = LocalObjectStore::read(Row::str($row, 'object_key'));

        return new TextResponse($bytes, 200, [
            'Content-Type' => $mimeType,
            // Metadata rides along in headers so the caller doesn't have to
            // re-sniff the mime type or re-derive the filename.
            'X-Image-Filename' => $filename,
            'X-Image-Mime' => $mimeType,
            'Content-Length' => (string)strlen($bytes),
            'Content-Disposition' => 'inline; filename="' . str_replace('"', '', $filename) . '"',
        ]);
    }

    /**
     * GET /api/nooks/{nookId}/notes/{noteId}/image
     *
     * The note-file counterpart of read(): the current image attached to a note
     * (an upload, an AI-generated image, or a chat-saved attachment that was
     * copied into a note), as raw bytes.
     *
     * This is what lets the model actually SEE a picture that already lives in
     * the user's notes. Previously the only way to learn about such an image was
     * get_note, which returns metadata (filename, mime, size) and no pixels —
     * so the model would report "I can't view the image pixels" while holding
     * perfectly good file details.
     */
    public function readNoteImage(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        NookAccess::requireMember($pdo, $user, $nookId);
        $noteId = $request->requireUuidRouteParam('noteId');

        // A note carries exactly one file row (note_files is keyed by note_id),
        // holding the CURRENT version; earlier versions stay on disk under their
        // own object keys for the history UI.
        $stmt = $pdo->prepare(
            'select nf.object_key, nf.filename, nf.mime_type
             from global.note_files nf
             join global.notes n on n.id = nf.note_id
             where nf.note_id = :note_id and n.nook_id = :nook_id
             limit 1'
        );
        $stmt->execute([':note_id' => $noteId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('note has no attached file', 404);
        }

        $mimeType = Row::str($row, 'mime_type');
        if (!ImageBytes::isSupportedMime($mimeType)) {
            throw new HttpError('the note\'s file is not an image the model can view', 415);
        }
        $filename = Row::str($row, 'filename', 'image');
        $bytes = LocalObjectStore::read(Row::str($row, 'object_key'));

        return new TextResponse($bytes, 200, [
            'Content-Type' => $mimeType,
            'X-Image-Filename' => $filename,
            'X-Image-Mime' => $mimeType,
            'Content-Length' => (string)strlen($bytes),
            'Content-Disposition' => 'inline; filename="' . str_replace('"', '', $filename) . '"',
        ]);
    }

    // ─── internals ───────────────────────────────────────────────────

    private function requireOwnedConversation(PDO $pdo, string $userId, string $conversationId): void
    {
        $stmt = $pdo->prepare('select 1 from global.conversations where id = :id and user_id = :user_id limit 1');
        $stmt->execute([':id' => $conversationId, ':user_id' => $userId]);
        if ($stmt->fetchColumn() === false) {
            throw new HttpError('conversation not found', 404);
        }
    }

    /**
     * Next free attachment_index for this conversation, after checking the
     * per-conversation cap. The unique (conversation_id, attachment_index)
     * constraint is the real guard against a concurrent double-insert; this
     * just keeps the common path from tripping it.
     */
    private function reserveIndexes(PDO $pdo, string $conversationId, int $count): int
    {
        $stmt = $pdo->prepare(
            'select coalesce(max(attachment_index), 0) from global.conversation_images where conversation_id = :conversation_id'
        );
        $stmt->execute([':conversation_id' => $conversationId]);
        $max = $stmt->fetchColumn();
        $next = is_numeric($max) ? (int)$max + 1 : 1;

        if ($next + $count - 1 > self::MAX_PER_CONVERSATION) {
            throw new HttpError(
                'this conversation has too many attachments (max ' . self::MAX_PER_CONVERSATION . ') — start a new chat',
                400
            );
        }
        return $next;
    }

    /**
     * @param array<string, mixed> $body
     */
    private function optionalString(array $body, string $key): string
    {
        $v = $body[$key] ?? null;
        return is_string($v) ? trim($v) : '';
    }

    /**
     * @param array<string, mixed> $body
     */
    private function optionalUuid(array $body, string $key): ?string
    {
        $v = $this->optionalString($body, $key);
        if ($v === '' || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $v)) {
            return null;
        }
        return $v;
    }
}
