<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerationOptions;

/**
 * Validated body for POST /nooks/{nookId}/ai-images. Mirrors the
 * other request DTOs in this dir — controller calls fromJson() once
 * and reaches for typed properties.
 *
 * `size` is whitelist-validated up front so a typo from the AI
 * (e.g. "1024 x 1024") is caught before we burn an OpenAI call.
 */
final readonly class GenerateImageRequest
{
    private const ALLOWED_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
    private const ALLOWED_QUALITIES = ['low', 'medium', 'high', 'auto'];

    /** Default quality for AI-initiated generation — keeps cost bounded for iteration. */
    public const DEFAULT_QUALITY = 'low';

    public function __construct(
        public string $prompt,
        public ?string $size,
        public bool $transparent,
        public string $quality,
        public ?string $summary,
        public ?string $refineNoteId,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromJson(array $data): self
    {
        $prompt = JsonReader::optionalTrimmedString($data, 'prompt');
        if ($prompt === '') {
            throw new HttpError('prompt is required', 400);
        }
        if (strlen($prompt) > 4000) {
            // gpt-image-1's documented cap is 32000 chars but anything
            // approaching that is almost always a bug, not a real
            // prompt; reject early to avoid a slow round-trip.
            throw new HttpError('prompt is too long (max 4000 chars)', 400);
        }

        $size = JsonReader::optionalTrimmedString($data, 'size');
        if ($size !== '' && !in_array($size, self::ALLOWED_SIZES, true)) {
            throw new HttpError('size must be one of: ' . implode(', ', self::ALLOWED_SIZES), 400);
        }

        $quality = JsonReader::optionalTrimmedString($data, 'quality');
        if ($quality !== '' && !in_array($quality, self::ALLOWED_QUALITIES, true)) {
            throw new HttpError('quality must be one of: ' . implode(', ', self::ALLOWED_QUALITIES), 400);
        }

        $transparent = ($data['transparent'] ?? false) === true;

        // Summary is the human-readable narrative the AI writes per
        // generation — seeds the note body. Optional in the API (older
        // callers stay valid); the AI tool description will mark it as
        // recommended.
        $summary = JsonReader::optionalTrimmedString($data, 'summary');
        $refineNoteId = JsonReader::optionalTrimmedString($data, 'refine_note_id');

        return new self(
            prompt: $prompt,
            size: $size !== '' ? $size : null,
            transparent: $transparent,
            quality: $quality !== '' ? $quality : self::DEFAULT_QUALITY,
            summary: $summary !== '' ? $summary : null,
            refineNoteId: $refineNoteId !== '' ? $refineNoteId : null,
        );
    }

    public function toOptions(): ImageGenerationOptions
    {
        return new ImageGenerationOptions(
            size: $this->size,
            transparent: $this->transparent,
            quality: $this->quality,
        );
    }
}
