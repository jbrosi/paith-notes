<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * Snapshot of an existing generated_image note, gathered before a
 * refinement so the controller can:
 *   - inherit unspecified options (size/quality/transparent) from
 *     the prior generation;
 *   - compute the next file_version;
 *   - append a versioned summary block to the existing content body;
 *   - update the typed attributes in place by their (already
 *     resolved) attribute ids.
 *
 * Pure data carrier — merge logic stays on the controller so this
 * DTO doesn't drag in the HTTP-layer request DTO.
 */
final readonly class PriorImageGeneration
{
    /**
     * @param array<string, string> $attributesByKey  attribute key (slug) → attribute id
     * @param array<string, mixed> $priorAttributes   attribute id → stored value, as read from the note
     */
    public function __construct(
        public string $noteId,
        public string $typeId,
        public string $fileAttributeId,
        public array $attributesByKey,
        public ImageGenerationOptions $priorOptions,
        public array $priorAttributes,
        public string $priorContent,
        public int $priorFileVersion,
    ) {
    }
}
