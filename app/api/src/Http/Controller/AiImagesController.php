<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\User;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Dto\GenerateImageRequest;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Service\ImageGeneration\GeneratedImage;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerator;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGeneratorFactory;
use Paith\Notes\Shared\Db\Row;
use PDO;
use Throwable;

/**
 * POST /api/nooks/{nookId}/ai-images
 *
 * AI-driven image generation. Wraps a swappable ImageGenerator (env:
 * IMAGE_PROVIDER) and persists the result as a regular file-typed
 * note in the target nook — reusing the same storage scheme as
 * AttributeFilesController so the file shows up alongside any other
 * uploaded asset.
 *
 * The route accepts either a real nook UUID or the literal sentinel
 * "ai-memory", mirroring GET /nooks/ai-memory; the AI uses the
 * sentinel by default so generated images land in the user's AI
 * memory nook unless they explicitly say "drop it in this nook".
 */
final class AiImagesController
{
    private const FILE_TYPE_KEY = 'file';
    private const FILE_ATTRIBUTE_NAME = 'File';
    private const FILE_ATTRIBUTE_KIND = 'file';
    private const TITLE_MAX_LEN = 80;

    /**
     * Override hook for tests — set IMAGE_PROVIDER=fake via env
     * instead in production; this static lets feature tests inject a
     * specific instance when env overrides aren't enough.
     */
    public static ?ImageGenerator $generatorOverride = null;

    public function generate(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookIdParam = trim($request->routeParam('nookId'));
        if ($nookIdParam === '') {
            throw new HttpError('nookId is required', 400);
        }
        $nookId = $this->resolveNookId($pdo, $user, $nookIdParam);

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $payload = GenerateImageRequest::fromJson($request->jsonBody());

        $generator = self::$generatorOverride ?? ImageGeneratorFactory::fromEnv();
        $image = $generator->generate($payload->prompt, $payload->toOptions());

        return $this->persistAsNote($pdo, $user, $nookId, $payload->prompt, $image);
    }

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
        // Otherwise fall through to the standard UUID validation path
        // performed by NookAccess::requireWriteAccess.
        return $nookIdOrAlias;
    }

    /**
     * Ensure the nook has a `file` type with a file-kind attribute,
     * insert the note row, write the bytes to disk, insert the
     * note_files pointer — same shape as AttributeFilesController's
     * upload path, just sourcing bytes from the generator instead of
     * an HTTP upload.
     */
    private function persistAsNote(PDO $pdo, User $user, string $nookId, string $originalPrompt, GeneratedImage $image): Response
    {
        $userId = $user->id;

        try {
            $pdo->beginTransaction();

            [$typeId, $attributeId] = $this->ensureFileTypeAndAttribute($pdo, $nookId);

            // Pre-generate the note id so the object key can include
            // it (same pattern as AttributeFilesController).
            $genStmt = $pdo->query('select gen_random_uuid()::text');
            $genId = $genStmt !== false ? $genStmt->fetchColumn() : null;
            $noteId = is_string($genId) ? trim($genId) : '';
            if ($noteId === '') {
                throw new HttpError('failed to generate note id', 500);
            }

            $fileVersion = 1;
            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $attributeId, $fileVersion);
            $extension = $this->extensionFor($image->mimeType);
            $filename = 'generated.' . $extension;
            $title = $this->buildTitle($image->revisedPrompt ?? $originalPrompt);
            $attributes = [$attributeId => ['file_version' => $fileVersion]];

            // INSERT note first so a UUID collision fails before we
            // touch disk.
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

            $this->writeBytesToDisk($objectKey, $image->bytes);

            $checksum = hash('sha256', $image->bytes);
            $filesize = strlen($image->bytes);

            $pdo->prepare(
                "insert into global.note_files (note_id, attribute_id, object_key, filename, extension, filesize, mime_type, checksum, file_version, uploaded_by, nook_id, updated_at) "
                . "values (:note_id, :attribute_id, :object_key, :filename, :extension, :filesize, :mime_type, :checksum, :file_version, :uploaded_by, :nook_id, now())"
            )->execute([
                ':note_id' => $noteId,
                ':attribute_id' => $attributeId,
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => $filesize,
                ':mime_type' => $image->mimeType,
                ':checksum' => $checksum,
                ':file_version' => $fileVersion,
                ':uploaded_by' => $userId,
                ':nook_id' => $nookId,
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => $noteId,
                    'nook_id' => $nookId,
                    'title' => $title,
                    'type_id' => $typeId,
                    'attributes' => $attributes,
                    'created_at' => $createdAt,
                ],
                'file' => [
                    'attribute_id' => $attributeId,
                    'object_key' => $objectKey,
                    'filename' => $filename,
                    'extension' => $extension,
                    'filesize' => $filesize,
                    'mime_type' => $image->mimeType,
                    'file_version' => $fileVersion,
                ],
                'revised_prompt' => $image->revisedPrompt,
                'provider_model' => $image->providerModel,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * @return array{0: string, 1: string} [typeId, attributeId]
     */
    private function ensureFileTypeAndAttribute(PDO $pdo, string $nookId): array
    {
        // Look up first — almost always present once the nook has
        // been visited via /note-types (which auto-creates the file
        // type). Fall through to insert when missing (e.g. AI's first
        // touch of a brand-new ai-memory nook).
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
            // If the insert lost a race (returning is empty), re-read.
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
        $stmt->execute([':nook_id' => $nookId, ':type_id' => $typeId, ':kind' => self::FILE_ATTRIBUTE_KIND]);
        $id = $stmt->fetchColumn();
        return is_string($id) ? $id : '';
    }

    private function writeBytesToDisk(string $objectKey, string $bytes): void
    {
        $path = self::dataPath() . '/' . ltrim($objectKey, '/');
        $dir = dirname($path);
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0777, true) && !is_dir($dir)) {
                throw new HttpError('failed to create image storage dir', 500);
            }
        }
        if (file_put_contents($path, $bytes) === false) {
            throw new HttpError('failed to write image bytes', 500);
        }
    }

    private function buildTitle(string $source): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', $source) ?? '');
        if ($clean === '') {
            return 'Generated image';
        }
        if (strlen($clean) <= self::TITLE_MAX_LEN) {
            return $clean;
        }
        // Hard truncate then trim trailing space so we don't end on
        // the middle of a word with a stray space before the ellipsis.
        return rtrim(substr($clean, 0, self::TITLE_MAX_LEN - 1)) . '…';
    }

    private function extensionFor(string $mimeType): string
    {
        return match ($mimeType) {
            'image/png' => 'png',
            'image/webp' => 'webp',
            'image/jpeg' => 'jpg',
            default => 'bin',
        };
    }

    private static function dataPath(): string
    {
        $path = trim((string)getenv('FILES_DATA_PATH'));
        return $path !== '' ? rtrim($path, '/') : '/data';
    }
}
