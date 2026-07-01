<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * Minimal HTTP transport seam used by the image-provider impls.
 * Exists so unit tests can swap out the real cURL call for a
 * deterministic stub without us pulling in a full HTTP-client dep.
 *
 * The contract intentionally returns a status + raw body (no
 * exception on non-2xx) so provider impls can do their own
 * error-code mapping.
 */
interface HttpTransport
{
    /**
     * @param array<string, string> $headers  request headers, name => value
     * @return array{status: int, body: string}
     */
    public function postJson(string $url, array $headers, string $jsonBody, int $timeoutSeconds): array;

    /**
     * Multipart POST. Each part has a `name`; when `filename` is set
     * the part is a file (binary `value` bytes + provider Content-Type),
     * otherwise it's a regular form field (text `value`).
     *
     * Used by ImageGenerator::edit so providers can ship raw image
     * bytes from memory without the transport caller having to know
     * how to build multipart bodies.
     *
     * @param array<string, string> $headers  request headers (Content-Type is set by the impl)
     * @param list<array{name: string, value: string, filename?: string, contentType?: string}> $parts
     * @return array{status: int, body: string}
     */
    public function postMultipart(string $url, array $headers, array $parts, int $timeoutSeconds): array;
}
