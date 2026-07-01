<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * One input image fed to ImageGenerator::edit. Held as bytes (not a
 * path) because sources are loaded from note_files rows whose on-disk
 * layout is the controller's business, not the provider's.
 *
 * `filename` is what gets sent as the multipart filename. It doesn't
 * need to match anything on our disk — providers use it only to infer
 * extension/format when Content-Type is ambiguous.
 */
final readonly class SourceImage
{
    public function __construct(
        public string $bytes,
        public string $mimeType,
        public string $filename,
    ) {
    }
}
