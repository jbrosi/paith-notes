<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * Provider-neutral knobs for one image generation request. Properties
 * are all optional — the impl picks a sensible default per provider
 * (gpt-image-1 defaults to 1024x1024 opaque).
 *
 * Size is encoded as "{w}x{h}" rather than a pair of ints because
 * every current provider uses that format on the wire; widening to
 * arbitrary integers would just force the impl to re-serialize.
 */
final readonly class ImageGenerationOptions
{
    public function __construct(
        public ?string $size = null,
        public bool $transparent = false,
    ) {
    }
}
