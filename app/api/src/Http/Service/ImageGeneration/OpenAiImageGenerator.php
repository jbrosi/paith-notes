<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Shared\Db\Row;

/**
 * OpenAI text-to-image via gpt-image-1.
 *
 * Requests the b64_json response_format so the bytes come back
 * inline; that avoids a second round-trip to fetch a CDN URL and
 * keeps the controller's "generate → store" sequence in one txn.
 *
 * Error mapping (per HttpError contract on ImageGenerator):
 *  - 400 from OpenAI  → HttpError(400) — usually policy violation,
 *                       passed through so the user sees the message
 *  - 401              → HttpError(500) — our credentials are wrong;
 *                       it's a config bug, not a user error
 *  - 429 / 5xx / TX   → HttpError(502) — transient upstream issue
 */
final class OpenAiImageGenerator implements ImageGenerator
{
    private const ENDPOINT = 'https://api.openai.com/v1/images/generations';
    private const DEFAULT_SIZE = '1024x1024';
    private const TIMEOUT_SECONDS = 120;

    public function __construct(
        private readonly string $apiKey,
        private readonly string $model,
        private readonly HttpTransport $transport,
    ) {
        if ($apiKey === '') {
            throw new HttpError('OPENAI_API_KEY is not configured', 500);
        }
    }

    public function generate(string $prompt, ImageGenerationOptions $options): GeneratedImage
    {
        $prompt = trim($prompt);
        if ($prompt === '') {
            throw new HttpError('prompt must be a non-empty string', 400);
        }

        $payload = [
            'model' => $this->model,
            'prompt' => $prompt,
            'n' => 1,
            'size' => $options->size !== null && $options->size !== '' ? $options->size : self::DEFAULT_SIZE,
            'background' => $options->transparent ? 'transparent' : 'opaque',
        ];

        $jsonBody = json_encode($payload);
        if ($jsonBody === false) {
            throw new HttpError('failed to serialize image request', 500);
        }

        $response = $this->transport->postJson(
            self::ENDPOINT,
            [
                'Authorization' => 'Bearer ' . $this->apiKey,
                'Content-Type' => 'application/json',
            ],
            $jsonBody,
            self::TIMEOUT_SECONDS,
        );

        return $this->parseResponse($response['status'], $response['body']);
    }

    private function parseResponse(int $status, string $body): GeneratedImage
    {
        $decoded = json_decode($body, true);
        $decoded = is_array($decoded) ? Row::stringKeyed($decoded) : [];

        if ($status === 200) {
            return $this->parseSuccess($decoded);
        }

        $errorMessage = $this->extractErrorMessage($decoded, $body);

        // 400 from OpenAI is almost always content policy or malformed
        // prompt — surface the upstream message directly so the AI can
        // adjust and retry without us paraphrasing it.
        if ($status === 400) {
            throw new HttpError($errorMessage, 400);
        }
        if ($status === 401 || $status === 403) {
            // The user can't fix this. Log shape stays generic so
            // failed-call telemetry doesn't leak the key.
            throw new HttpError('image provider authentication failed', 500);
        }

        // 429 and 5xx → transient; let the caller decide whether to
        // surface "try again in a moment" or retry server-side later.
        throw new HttpError('image provider error: ' . $errorMessage, 502);
    }

    /** @param array<string, mixed> $decoded */
    private function parseSuccess(array $decoded): GeneratedImage
    {
        $data = $decoded['data'] ?? null;
        if (!is_array($data) || !isset($data[0]) || !is_array($data[0])) {
            throw new HttpError('image provider returned no image data', 502);
        }
        $entry = Row::stringKeyed($data[0]);

        $b64 = $entry['b64_json'] ?? null;
        if (!is_string($b64) || $b64 === '') {
            throw new HttpError('image provider returned no image bytes', 502);
        }
        $bytes = base64_decode($b64, true);
        if ($bytes === false || $bytes === '') {
            throw new HttpError('image provider returned undecodable image bytes', 502);
        }

        $revised = $entry['revised_prompt'] ?? null;
        $revisedPrompt = is_string($revised) && trim($revised) !== '' ? $revised : null;

        return new GeneratedImage(
            bytes: $bytes,
            mimeType: 'image/png',
            revisedPrompt: $revisedPrompt,
            providerModel: 'openai/' . $this->model,
        );
    }

    /** @param array<string, mixed> $decoded */
    private function extractErrorMessage(array $decoded, string $fallback): string
    {
        $error = $decoded['error'] ?? null;
        if (is_array($error)) {
            $msg = Row::stringKeyed($error)['message'] ?? null;
            if (is_string($msg) && $msg !== '') {
                return $msg;
            }
        }
        // Body might be HTML (e.g. CloudFront error page) — clamp so
        // we don't dump kilobytes into our own error response.
        return substr($fallback, 0, 200);
    }
}
