<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

use Paith\Notes\Api\Http\HttpError;

/**
 * Default HttpTransport — thin cURL wrapper. Lives next to the
 * interface (not in some shared http/ namespace) because it's the
 * only call out to a third party from the API process right now.
 *
 * Transport-layer failures (DNS, timeout, TLS) bubble as
 * HttpError(502) so the caller can present a clean "upstream
 * unavailable" without inspecting cURL error codes.
 */
final class CurlHttpTransport implements HttpTransport
{
    public function postJson(string $url, array $headers, string $jsonBody, int $timeoutSeconds): array
    {
        if ($url === '') {
            throw new HttpError('image provider URL is empty', 502);
        }
        // CURLOPT_POSTFIELDS wants non-empty-string per phpstan;
        // image generation never produces an empty body in practice
        // but we still guard so the lint constraint holds.
        if ($jsonBody === '') {
            throw new HttpError('refusing to POST an empty body', 502);
        }

        $ch = curl_init();
        if ($ch === false) {
            throw new HttpError('failed to initialize HTTP client', 502);
        }

        $headerLines = [];
        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonBody);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headerLines);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeoutSeconds);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

        $body = curl_exec($ch);
        // NOTE: no curl_close($ch) — deprecated since PHP 8.0 and
        // emits a notice on 8.5. CurlHandle is a normal object now;
        // it's released when $ch goes out of scope at function exit.
        if ($body === false || $body === true) {
            throw new HttpError('image provider transport error: ' . curl_error($ch), 502);
        }
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        return ['status' => $status, 'body' => $body];
    }
}
