<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

use Paith\Notes\Api\Http\HttpError;

/**
 * Deterministic stand-in used by tests and as the default when no
 * upstream provider is configured. Returns a tiny valid 1x1 PNG so
 * downstream code (mime detection, filesize, image-tag rendering)
 * has real bytes to work with — no network, no spend.
 *
 * Also exercises the prompt rejection path: any prompt containing
 * the word "REJECT" throws HttpError(400) so the policy-violation
 * branch can be tested without hitting OpenAI.
 */
final class FakeImageGenerator implements ImageGenerator
{
    public function generate(string $prompt, ImageGenerationOptions $options): GeneratedImage
    {
        return $this->produce($prompt, sourceCount: 0);
    }

    public function edit(string $prompt, array $sources, ImageGenerationOptions $options): GeneratedImage
    {
        if ($sources === []) {
            throw new HttpError('edit requires at least one source image', 400);
        }
        return $this->produce($prompt, sourceCount: count($sources));
    }

    private function produce(string $prompt, int $sourceCount): GeneratedImage
    {
        if (stripos($prompt, 'REJECT') !== false) {
            throw new HttpError('fake-rejected prompt', 400);
        }

        // 1x1 transparent PNG — base64 decoded once for honesty.
        $bytes = base64_decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            true
        );
        if ($bytes === false) {
            throw new HttpError('fake generator failed to decode static PNG', 500);
        }

        // Echo the prompt back as revisedPrompt so tests can assert
        // round-trip; on edit, tag the count so test assertions can
        // distinguish edit calls from generate calls without snooping
        // the transport.
        $revised = $sourceCount > 0
            ? sprintf('[edited from %d source(s)] %s', $sourceCount, $prompt)
            : $prompt;

        return new GeneratedImage(
            bytes: $bytes,
            mimeType: 'image/png',
            revisedPrompt: $revised,
            providerModel: 'fake/static-png',
        );
    }
}
