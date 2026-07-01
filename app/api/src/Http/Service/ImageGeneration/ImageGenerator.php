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
     * Text-to-image. The provider produces a fresh image from `prompt`
     * alone — no input image is referenced.
     *
     * @throws HttpError on validation failures (400) or upstream errors (502)
     */
    public function generate(string $prompt, ImageGenerationOptions $options): GeneratedImage;

    /**
     * Image-to-image. The provider takes one or more `sources` as
     * input and produces a new image guided by `prompt`. Used for
     * "enhance my daughter's drawing" / "the same image but with a
     * sunset" style workflows where the source must stay the anchor
     * across iterations.
     *
     * The sources are bytes-in-memory rather than paths so this layer
     * doesn't have to know about the controller's on-disk file layout.
     *
     * @param list<SourceImage> $sources  at least one
     * @throws HttpError on validation failures (400) or upstream errors (502)
     */
    public function edit(string $prompt, array $sources, ImageGenerationOptions $options): GeneratedImage;
}
