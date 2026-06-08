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
 *
 * Quality is the provider's quality knob — "low"/"medium"/"high" or
 * "auto". For gpt-image-1 the cost step is dramatic (~$0.01 low,
 * ~$0.04 medium, ~$0.17 high for 1024x1024) so callers should default
 * low and only escalate on user request.
 */
final readonly class ImageGenerationOptions
{
    public function __construct(
        public ?string $size = null,
        public bool $transparent = false,
        public ?string $quality = null,
    ) {
    }
}
