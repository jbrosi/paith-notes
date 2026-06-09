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
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerationOptions;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerator;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGeneratorFactory;
use Paith\Notes\Api\Http\Service\ImageGeneration\PriorImageGeneration;
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

    private const GENERATED_IMAGE_TYPE_KEY = 'generated_image';

    /**
     * Attribute schema for the generated_image type — the rich metadata
     * we capture per AI-generated image when storing in ai-memory. Each
     * entry is [name, key, kind, config, indexed?]. Inserts use the key
     * for lookup so renames of the display name don't break attribute
     * resolution.
     *
     * @var list<array{name: string, key: string, kind: string, config: array<string, mixed>, indexed: bool}>
     */
    private const GENERATED_IMAGE_ATTRIBUTES = [
        ['name' => 'Prompt',         'key' => 'prompt',         'kind' => 'text',      'config' => ['display' => 'paragraph'], 'indexed' => true],
        ['name' => 'Revised prompt', 'key' => 'revised_prompt', 'kind' => 'text',      'config' => ['display' => 'paragraph'], 'indexed' => true],
        ['name' => 'Size',           'key' => 'size',           'kind' => 'dimension', 'config' => [], 'indexed' => true],
        ['name' => 'Quality',        'key' => 'quality',        'kind' => 'text',      'config' => [], 'indexed' => true],
        ['name' => 'Transparent',    'key' => 'transparent',    'kind' => 'boolean',   'config' => [], 'indexed' => false],
        ['name' => 'Model',          'key' => 'model',          'kind' => 'text',      'config' => [], 'indexed' => true],
        ['name' => 'Cost',           'key' => 'cost_usd',       'kind' => 'number',    'config' => ['display' => 'currency', 'currency' => 'USD'], 'indexed' => true],
        ['name' => 'Input tokens',   'key' => 'input_tokens',   'kind' => 'number',    'config' => [], 'indexed' => true],
        ['name' => 'Output tokens',  'key' => 'output_tokens',  'kind' => 'number',    'config' => [], 'indexed' => true],
        ['name' => 'Duration',       'key' => 'duration_ms',    'kind' => 'number',    'config' => ['display' => 'duration'], 'indexed' => true],
        // 'content' kind is the note body rendered as a placeable
        // attribute — lets the layout decide where the markdown
        // changelog appears relative to the file and the telemetry.
        ['name' => 'Content',        'key' => 'content',        'kind' => 'content',   'config' => ['mode' => 'markdown'], 'indexed' => false],
    ];

    /**
     * Override hook for tests — set IMAGE_PROVIDER=fake via env
     * instead in production; this static lets feature tests inject a
     * specific instance when env overrides aren't enough.
     */
    public static ?ImageGenerator $generatorOverride = null;

    public function generate(Request $request, Context $context): Response
    {
        // gpt-image-1 routinely takes 20–60s for medium quality, and
        // FrankenPHP's default max_execution_time of 30s aborts the
        // request mid-generation. Bump just this endpoint to 180s —
        // matches the 120s cURL timeout in CurlHttpTransport with a
        // small buffer for storage + DB writes either side.
        set_time_limit(180);

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

        // Refinement vs. new-note branching. Refinement loads the
        // prior note's options and merges them with what the AI
        // explicitly passed; the generation call itself is identical.
        if ($payload->refineNoteId !== null) {
            $existing = $this->loadGeneratedImageForRefinement($pdo, $nookId, $payload->refineNoteId);
            $options = $this->mergeOptionsForRefinement($payload, $existing);
            $startMs = (int)(microtime(true) * 1000);
            $image = $generator->generate($payload->prompt, $options);
            $durationMs = max(0, (int)(microtime(true) * 1000) - $startMs);
            return $this->persistAsRefinement($pdo, $user, $nookId, $payload, $existing, $options, $image, $durationMs);
        }

        $startMs = (int)(microtime(true) * 1000);
        $image = $generator->generate($payload->prompt, $payload->toOptions());
        $durationMs = max(0, (int)(microtime(true) * 1000) - $startMs);

        return $this->persistAsNote($pdo, $user, $nookId, $payload, $image, $durationMs);
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
     * Ensure the right type is bootstrapped, insert the note row,
     * write the bytes to disk, insert the note_files pointer. For
     * ai-memory we use the rich `generated_image` type with all
     * typed telemetry attributes; for other nooks we fall back to
     * the plain `file` type with just the file pointer.
     */
    private function persistAsNote(PDO $pdo, User $user, string $nookId, GenerateImageRequest $payload, GeneratedImage $image, int $durationMs): Response
    {
        $userId = $user->id;

        try {
            $pdo->beginTransaction();

            $ctx = $this->resolveTargetTypeAndAttributes($pdo, $nookId);

            // Pre-generate the note id so the object key can include
            // it (same pattern as AttributeFilesController).
            $genStmt = $pdo->query('select gen_random_uuid()::text');
            $genId = $genStmt !== false ? $genStmt->fetchColumn() : null;
            $noteId = is_string($genId) ? trim($genId) : '';
            if ($noteId === '') {
                throw new HttpError('failed to generate note id', 500);
            }

            $fileVersion = 1;
            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $ctx['fileAttributeId'], $fileVersion);
            $extension = $this->extensionFor($image->mimeType);
            $filename = 'generated.' . $extension;
            $title = $this->buildTitle($payload->summary ?? $image->revisedPrompt ?? $payload->prompt);

            // Use the effective options that were actually sent to
            // the generator (after toOptions() defaults applied) so
            // the stored attributes reflect what was produced.
            $effective = $payload->toOptions();
            $attributes = $this->buildAttributesPayload($ctx, $payload->prompt, $effective, $image, $durationMs, $fileVersion);
            $content = $this->buildInitialContent($payload, $ctx['isGeneratedImage']);

            // INSERT note first so a UUID collision fails before we
            // touch disk.
            $noteStmt = $pdo->prepare(
                "insert into global.notes (id, nook_id, created_by, title, content, type_id, attributes) "
                . "values (:id, :nook_id, :created_by, :title, :content, :type_id, :attributes::jsonb) "
                . "returning created_at"
            );
            $noteStmt->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':created_by' => $userId,
                ':title' => $title,
                ':content' => $content,
                ':type_id' => $ctx['typeId'],
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
                ':attribute_id' => $ctx['fileAttributeId'],
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
                    'type_id' => $ctx['typeId'],
                    'attributes' => $attributes,
                    'created_at' => $createdAt,
                ],
                'file' => [
                    'attribute_id' => $ctx['fileAttributeId'],
                    'object_key' => $objectKey,
                    'filename' => $filename,
                    'extension' => $extension,
                    'filesize' => $filesize,
                    'mime_type' => $image->mimeType,
                    'file_version' => $fileVersion,
                ],
                'revised_prompt' => $image->revisedPrompt,
                'provider_model' => $image->providerModel,
                'usage' => $image->usage?->toArray(),
                'duration_ms' => $durationMs,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Assemble the attributes JSONB for the new note. Always sets
     * the file pointer; for generated_image type, also fills in the
     * rich telemetry attributes by key lookup.
     *
     * @param array{
     *     typeId: string,
     *     fileAttributeId: string,
     *     attributes: array<string, string>,
     *     isGeneratedImage: bool,
     * } $ctx
     * @return array<string, mixed>
     */
    private function buildAttributesPayload(array $ctx, string $prompt, ImageGenerationOptions $effective, GeneratedImage $image, int $durationMs, int $fileVersion): array
    {
        $attributes = [$ctx['fileAttributeId'] => ['file_version' => $fileVersion]];

        if (!$ctx['isGeneratedImage']) {
            return $attributes;
        }

        $byKey = $ctx['attributes'];
        // Use the effective size that was sent to OpenAI for the
        // dimension attribute. When size="auto" we fall back to
        // 1024x1024 because we can't infer the real generated size
        // from a base64 PNG without decoding it.
        $sizeStr = $effective->size ?? '1024x1024';
        if ($sizeStr === 'auto' || !str_contains($sizeStr, 'x')) {
            $width = 1024;
            $height = 1024;
        } else {
            // str_contains guard above means explode always returns 2 parts.
            $parts = explode('x', $sizeStr, 2);
            $width = (int)$parts[0];
            $height = (int)$parts[1];
        }

        $set = static function (string $key, mixed $value) use (&$attributes, $byKey): void {
            $attrId = $byKey[$key] ?? null;
            if (is_string($attrId) && $attrId !== '') {
                $attributes[$attrId] = $value;
            }
        };

        // Pull usage out into a local so phpstan can narrow it once;
        // the ternaries below stay readable instead of repeated nullsafe.
        $usage = $image->usage;

        $set('prompt', $prompt);
        $set('revised_prompt', $image->revisedPrompt ?? '');
        $set('size', ['width' => $width, 'height' => $height]);
        $set('quality', $effective->quality ?? 'low');
        $set('transparent', $effective->transparent);
        $set('model', $image->providerModel);
        $set('cost_usd', $usage !== null ? $usage->estimatedCostUsd : 0);
        $set('input_tokens', $usage !== null ? $usage->inputTokens : 0);
        $set('output_tokens', $usage !== null ? $usage->outputTokens : 0);
        $set('duration_ms', $durationMs);

        return $attributes;
    }

    /**
     * Build the initial note body. For generated_image notes we
     * seed with a versioned header so future refinements can append
     * subsequent v{N} sections — gives the user a chronological
     * narrative of how the image evolved.
     */
    private function buildInitialContent(GenerateImageRequest $payload, bool $isGeneratedImage): string
    {
        if (!$isGeneratedImage || $payload->summary === null || $payload->summary === '') {
            return '';
        }
        return "## v1\n\n" . $payload->summary . "\n";
    }

    // ─── Refinement path ──────────────────────────────────────────────

    /**
     * Load the prior note and validate it's eligible for refinement
     * (exists in this nook, type is generated_image). Returns the
     * fields we need to merge args and write back.
     */
    private function loadGeneratedImageForRefinement(PDO $pdo, string $nookId, string $noteId): PriorImageGeneration
    {
        // LEFT JOIN on note_types so we can still match notes with a
        // null/orphan type_id and surface a clean 400 ("not a
        // generated_image") rather than a confusing 404.
        $stmt = $pdo->prepare(
            "select n.id, n.type_id, n.content, n.attributes, t.key as type_key "
            . "from global.notes n "
            . "left join global.note_types t on t.id = n.type_id "
            . "where n.id = :id and n.nook_id = :nook_id"
        );
        $stmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('note to refine not found in this nook', 404);
        }
        if (Row::str($row, 'type_key') !== self::GENERATED_IMAGE_TYPE_KEY) {
            throw new HttpError('refinement only supported on generated_image notes', 400);
        }

        $typeId = Row::str($row, 'type_id');
        $byKey = $this->ensureGeneratedImageAttributes($pdo, $nookId, $typeId);

        // The file attribute id lives on the parent `file` type
        // (inherited), so it's not in the type_attributes rows for
        // generated_image. The note's own note_files row is the
        // authoritative source — read it directly.
        $fileRowStmt = $pdo->prepare(
            'select attribute_id, file_version from global.note_files where note_id = :nid limit 1'
        );
        $fileRowStmt->execute([':nid' => $noteId]);
        $fileRow = $fileRowStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($fileRow)) {
            throw new HttpError('refinement target has no associated file', 500);
        }
        $fileAttributeId = Row::str($fileRow, 'attribute_id');
        $priorFileVersion = Row::int($fileRow, 'file_version', 1);

        $priorAttrs = Row::decodeJsonObject($row['attributes'] ?? null);

        return new PriorImageGeneration(
            noteId: Row::str($row, 'id'),
            typeId: $typeId,
            fileAttributeId: $fileAttributeId,
            attributesByKey: $byKey,
            priorOptions: $this->extractPriorOptions($priorAttrs, $byKey),
            priorAttributes: $priorAttrs,
            priorContent: Row::str($row, 'content'),
            priorFileVersion: $priorFileVersion,
        );
    }

    /**
     * Reconstruct the ImageGenerationOptions that were used for the
     * prior generation so we can inherit unspecified args.
     *
     * @param array<string, mixed> $priorAttrs
     * @param array<string, string> $byKey
     */
    private function extractPriorOptions(array $priorAttrs, array $byKey): ImageGenerationOptions
    {
        $get = static function (string $key) use ($priorAttrs, $byKey): mixed {
            $attrId = $byKey[$key] ?? null;
            return is_string($attrId) ? ($priorAttrs[$attrId] ?? null) : null;
        };

        $sizeAttr = $get('size');
        $sizeStr = null;
        if (is_array($sizeAttr)) {
            $w = $sizeAttr['width'] ?? null;
            $h = $sizeAttr['height'] ?? null;
            if (is_int($w) && is_int($h)) {
                $sizeStr = $w . 'x' . $h;
            }
        }

        $quality = $get('quality');
        $transparent = $get('transparent');

        return new ImageGenerationOptions(
            size: $sizeStr,
            transparent: is_bool($transparent) ? $transparent : false,
            quality: is_string($quality) ? $quality : null,
        );
    }

    /**
     * Merge what the AI explicitly passed with the prior note's
     * options — fields the AI provided override; fields it omitted
     * fall back to what was used last time.
     */
    private function mergeOptionsForRefinement(GenerateImageRequest $payload, PriorImageGeneration $existing): ImageGenerationOptions
    {
        $prior = $existing->priorOptions;
        return new ImageGenerationOptions(
            size: $payload->size ?? $prior->size,
            transparent: $payload->transparent ?? $prior->transparent,
            quality: $payload->quality ?? $prior->quality,
        );
    }

    /**
     * Apply the regenerated image to the existing note: write the
     * new bytes to a fresh versioned path, bump file_version, update
     * typed attributes (audit_meta captures the old values for the
     * existing version-history UI), and append a `## v{N}` block to
     * the content body.
     */
    private function persistAsRefinement(PDO $pdo, User $user, string $nookId, GenerateImageRequest $payload, PriorImageGeneration $existing, ImageGenerationOptions $effective, GeneratedImage $image, int $durationMs): Response
    {
        $userId = $user->id;
        $noteId = $existing->noteId;
        $fileAttributeId = $existing->fileAttributeId;
        $fileVersion = $existing->priorFileVersion + 1;

        try {
            $pdo->beginTransaction();

            $objectKey = sprintf('notes/%s/files/%s/%s/v%d', $nookId, $noteId, $fileAttributeId, $fileVersion);
            $extension = $this->extensionFor($image->mimeType);
            $filename = 'generated.' . $extension;

            // Build the rich-attributes payload from the existing
            // attribute id map (saves re-querying the type).
            $ctx = [
                'typeId' => $existing->typeId,
                'fileAttributeId' => $fileAttributeId,
                'attributes' => $existing->attributesByKey,
                'isGeneratedImage' => true,
            ];
            $newAttributes = $this->buildAttributesPayload($ctx, $payload->prompt, $effective, $image, $durationMs, $fileVersion);
            // Note: bumping file_version on note_files (below) keeps
            // the row keyed by note_id but moves the pointer forward.
            // The prior v{N} file stays on disk so a future history-
            // browse UI can resurrect it; we don't reference it.

            $newContent = $this->appendVersionedSummary($existing->priorContent, $payload, $fileVersion);

            $this->writeBytesToDisk($objectKey, $image->bytes);
            $checksum = hash('sha256', $image->bytes);
            $filesize = strlen($image->bytes);

            // Update the note row — increments version + emits audit
            // trail via the existing triggers, so the prior values
            // are preserved for history compare.
            $update = $pdo->prepare(
                "update global.notes "
                . "set attributes = :attributes::jsonb, content = :content, updated_at = now() "
                . "where id = :id and nook_id = :nook_id "
                . "returning version, updated_at, created_at"
            );
            $update->execute([
                ':id' => $noteId,
                ':nook_id' => $nookId,
                ':attributes' => json_encode($newAttributes),
                ':content' => $newContent,
            ]);
            $noteRow = $update->fetch(PDO::FETCH_ASSOC);
            if (!is_array($noteRow)) {
                throw new HttpError('failed to update note for refinement', 500);
            }

            // Update note_files in place — file_version bumped, new
            // object_key + bytes metadata.
            $pdo->prepare(
                "update global.note_files set "
                . "  object_key = :object_key, "
                . "  filename = :filename, "
                . "  extension = :extension, "
                . "  filesize = :filesize, "
                . "  mime_type = :mime_type, "
                . "  checksum = :checksum, "
                . "  file_version = :file_version, "
                . "  uploaded_by = :uploaded_by, "
                . "  updated_at = now() "
                . "where note_id = :note_id and attribute_id = :attribute_id"
            )->execute([
                ':object_key' => $objectKey,
                ':filename' => $filename,
                ':extension' => $extension,
                ':filesize' => $filesize,
                ':mime_type' => $image->mimeType,
                ':checksum' => $checksum,
                ':file_version' => $fileVersion,
                ':uploaded_by' => $userId,
                ':note_id' => $noteId,
                ':attribute_id' => $fileAttributeId,
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'note' => [
                    'id' => $noteId,
                    'nook_id' => $nookId,
                    'type_id' => $existing->typeId,
                    'version' => Row::int($noteRow, 'version'),
                    'attributes' => $newAttributes,
                    'refined' => true,
                ],
                'file' => [
                    'attribute_id' => $fileAttributeId,
                    'object_key' => $objectKey,
                    'filename' => $filename,
                    'extension' => $extension,
                    'filesize' => $filesize,
                    'mime_type' => $image->mimeType,
                    'file_version' => $fileVersion,
                ],
                'revised_prompt' => $image->revisedPrompt,
                'provider_model' => $image->providerModel,
                'usage' => $image->usage?->toArray(),
                'duration_ms' => $durationMs,
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Append a versioned summary block to the existing note body.
     * Format mirrors buildInitialContent's "## v1" header so the
     * combined output reads as a single chronological log.
     */
    private function appendVersionedSummary(string $priorContent, GenerateImageRequest $payload, int $newVersion): string
    {
        $summary = $payload->summary ?? '';
        if ($summary === '') {
            $summary = '(no summary provided)';
        }
        $stamp = gmdate('Y-m-d\TH:i:s\Z');
        $header = "## v{$newVersion} — {$stamp}";
        $block = "{$header}\n\n{$summary}\n";

        $trimmed = rtrim($priorContent);
        return $trimmed === '' ? $block : $trimmed . "\n\n" . $block;
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

    /**
     * Resolve the note type + attribute id map to use when storing
     * a generated image in this nook. AI-memory gets the rich
     * `generated_image` type with all telemetry attributes; other
     * nooks fall back to the plain `file` type (no rich metadata,
     * just the file pointer) so generation still works there without
     * polluting the nook with AI-specific schema.
     *
     * @return array{
     *     typeId: string,
     *     fileAttributeId: string,
     *     attributes: array<string, string>,
     *     isGeneratedImage: bool,
     * }
     */
    private function resolveTargetTypeAndAttributes(PDO $pdo, string $nookId): array
    {
        $isAiMemory = $this->isAiMemoryNook($pdo, $nookId);
        // Ensure the parent `file` type exists either way — it carries
        // the file attribute that the generated image actually points
        // at (inherited from parent in the ai-memory case).
        [$fileTypeId, $fileAttributeId] = $this->ensureFileTypeAndAttribute($pdo, $nookId);

        if (!$isAiMemory) {
            return [
                'typeId' => $fileTypeId,
                'fileAttributeId' => $fileAttributeId,
                'attributes' => [],
                'isGeneratedImage' => false,
            ];
        }

        $typeId = $this->ensureGeneratedImageType($pdo, $nookId, $fileTypeId);
        $attributes = $this->ensureGeneratedImageAttributes($pdo, $nookId, $typeId);
        $this->ensureGeneratedImageLayout($pdo, $typeId, $fileAttributeId, $attributes);

        return [
            'typeId' => $typeId,
            'fileAttributeId' => $fileAttributeId,
            'attributes' => $attributes,
            'isGeneratedImage' => true,
        ];
    }

    /**
     * Set the default layout on the generated_image type if it
     * doesn't have one yet: file + content body share the main
     * panel; everything else (the 10 typed telemetry attrs) goes
     * into a single side-right panel.
     *
     * Only writes when attribute_layout is null / empty — if a user
     * has customised the layout via the UI (rare given the type is
     * system-owned, but possible), we leave their version alone.
     *
     * @param array<string, string> $attributesByKey  key → attribute id
     */
    private function ensureGeneratedImageLayout(PDO $pdo, string $typeId, string $fileAttributeId, array $attributesByKey): void
    {
        $check = $pdo->prepare("select attribute_layout from global.note_types where id = :id");
        $check->execute([':id' => $typeId]);
        $raw = $check->fetchColumn();
        if (is_string($raw) && $raw !== '' && $raw !== 'null' && $raw !== '{}') {
            // A non-empty layout already exists; respect it.
            return;
        }

        $contentAttrId = $attributesByKey['content'] ?? null;
        if (!is_string($contentAttrId) || $contentAttrId === '' || $fileAttributeId === '') {
            // Missing the anchor attributes — bail rather than write a
            // half-built layout that the validator would later reject.
            return;
        }

        // Side panel order mirrors the human reading order: what the
        // user asked for first, then the model's read of it, then the
        // dimensions, then the runtime telemetry.
        $sideKeys = [
            'prompt',
            'revised_prompt',
            'size',
            'quality',
            'transparent',
            'model',
            'cost_usd',
            'input_tokens',
            'output_tokens',
            'duration_ms',
        ];
        $sideAttrs = [];
        foreach ($sideKeys as $k) {
            $id = $attributesByKey[$k] ?? null;
            if (is_string($id) && $id !== '') {
                $sideAttrs[] = $id;
            }
        }

        $layout = [
            'panels' => [
                [
                    'key' => 'main',
                    'position' => 'main',
                    'attributes' => [$fileAttributeId, $contentAttrId],
                ],
                [
                    'key' => 'details',
                    'label' => 'Details',
                    'position' => 'side-right',
                    'attributes' => $sideAttrs,
                ],
            ],
        ];

        $update = $pdo->prepare(
            "update global.note_types set attribute_layout = :layout::jsonb, updated_at = now() "
            . "where id = :id"
        );
        $update->execute([':id' => $typeId, ':layout' => json_encode($layout)]);
    }

    private function isAiMemoryNook(PDO $pdo, string $nookId): bool
    {
        $stmt = $pdo->prepare("select purpose from global.nooks where id = :id");
        $stmt->execute([':id' => $nookId]);
        $purpose = $stmt->fetchColumn();
        return $purpose === 'ai-memory';
    }

    private function ensureGeneratedImageType(PDO $pdo, string $nookId, string $fileTypeId): string
    {
        $stmt = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $stmt->execute([':nook_id' => $nookId, ':key' => self::GENERATED_IMAGE_TYPE_KEY]);
        $id = $stmt->fetchColumn();
        if (is_string($id) && $id !== '') {
            return $id;
        }

        $insert = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, description, parent_id) '
            . 'values (:nook_id, :key, :label, :description, :parent_id) '
            . 'on conflict (nook_id, key) do nothing '
            . 'returning id'
        );
        $insert->execute([
            ':nook_id' => $nookId,
            ':key' => self::GENERATED_IMAGE_TYPE_KEY,
            ':label' => 'Generated Image',
            ':description' => 'An AI-generated image, with the prompt, model, cost, and dimensions captured as typed attributes.',
            ':parent_id' => $fileTypeId !== '' ? $fileTypeId : null,
        ]);
        $newId = $insert->fetchColumn();
        if (is_string($newId) && $newId !== '') {
            return $newId;
        }
        // Race fallback — another request landed the row first; re-read.
        $stmt->execute([':nook_id' => $nookId, ':key' => self::GENERATED_IMAGE_TYPE_KEY]);
        $id = $stmt->fetchColumn();
        if (!is_string($id) || $id === '') {
            throw new HttpError('failed to bootstrap generated_image note type', 500);
        }
        return $id;
    }

    /**
     * Idempotently seed the GENERATED_IMAGE_ATTRIBUTES on the given
     * type. Returns key → attribute_id for every attribute (existing
     * ones included).
     *
     * @return array<string, string>
     */
    private function ensureGeneratedImageAttributes(PDO $pdo, string $nookId, string $typeId): array
    {
        $insert = $pdo->prepare(
            'insert into global.type_attributes (nook_id, type_id, name, key, kind, config, indexed) '
            . 'values (:nook_id, :type_id, :name, :key, :kind, :config::jsonb, :indexed) '
            . 'on conflict (type_id, key) do nothing'
        );
        foreach (self::GENERATED_IMAGE_ATTRIBUTES as $attr) {
            $insert->execute([
                ':nook_id' => $nookId,
                ':type_id' => $typeId,
                ':name' => $attr['name'],
                ':key' => $attr['key'],
                ':kind' => $attr['kind'],
                ':config' => json_encode($attr['config']),
                ':indexed' => $attr['indexed'] ? 't' : 'f',
            ]);
        }

        // Read back the id of every key we expect, so callers can
        // index by key without needing the seed config.
        $lookup = $pdo->prepare(
            'select key, id from global.type_attributes where type_id = :type_id'
        );
        $lookup->execute([':type_id' => $typeId]);
        $result = [];
        while ($row = $lookup->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($row)) {
                continue;
            }
            $key = Row::str($row, 'key');
            $id = Row::str($row, 'id');
            if ($key !== '' && $id !== '') {
                $result[$key] = $id;
            }
        }
        return $result;
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

        // @-prefix so PHP warnings (permission denied, etc.) don't leak
        // into the response body before the exception turns into JSON;
        // the actual reason gets surfaced via error_get_last() instead.
        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0777, true) && !is_dir($dir)) {
                throw new HttpError('failed to create image storage dir: ' . self::lastErrorMessage(), 500);
            }
        }
        if (@file_put_contents($path, $bytes) === false) {
            throw new HttpError('failed to write image bytes: ' . self::lastErrorMessage(), 500);
        }
    }

    private static function lastErrorMessage(): string
    {
        $err = error_get_last();
        return is_array($err) ? $err['message'] : 'unknown error';
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
