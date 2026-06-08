<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * One generated image returned from an ImageGenerator. `bytes` is
 * the raw binary payload (caller writes it to disk); `mimeType` is
 * the actual format produced (image/png by default for gpt-image-1,
 * image/webp when transparent is requested on some providers).
 *
 * `revisedPrompt` is what gpt-image-1 reformulated the user's prompt
 * to — useful as the note title and worth surfacing to the user so
 * they understand the model's interpretation. Null when the provider
 * doesn't return one.
 *
 * `providerModel` is a stable identifier of who produced the image
 * (e.g. "openai/gpt-image-1") so the audit trail survives a provider
 * swap.
 */
final readonly class GeneratedImage
{
    public function __construct(
        public string $bytes,
        public string $mimeType,
        public ?string $revisedPrompt,
        public string $providerModel,
        public ?ImageUsage $usage = null,
    ) {
    }
}
