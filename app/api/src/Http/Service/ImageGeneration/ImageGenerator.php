<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

use Paith\Notes\Api\Http\HttpError;

/**
 * Provider-neutral interface for text-to-image generation. The whole
 * point of having this is so swapping from OpenAI to FLUX / Imagen /
 * a local model later is one factory-config line, not a controller
 * rewrite.
 *
 * Implementations must:
 *  - throw HttpError(400) on prompts the provider rejects (policy
 *    violations, malformed input);
 *  - throw HttpError(502) on transient upstream failures so the
 *    caller can surface "image provider unavailable" rather than 500;
 *  - never log the API key.
 */
interface ImageGenerator
{
    /**
     * @throws HttpError on validation failures (400) or upstream errors (502)
     */
    public function generate(string $prompt, ImageGenerationOptions $options): GeneratedImage;
}
