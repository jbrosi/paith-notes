<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\Images;

use Paith\Notes\Api\Http\HttpError;

/**
 * Shared decoding / mime-sniffing for image payloads that arrive as base64
 * (chat attachments, chat-image saves).
 *
 * Lives in its own class because both ChatImagesController (save) and
 * ChatAttachmentsController (stash) need identical rules — a divergence
 * between them would mean an image that can be attached but not saved (or the
 * reverse). Keeping the whitelist in one place makes that impossible.
 */
final class ImageBytes
{
    /** Mime → file extension. The whitelist is the gate for everything we
     *  accept as an image; anything outside it is rejected rather than stored. */
    private const MIME_TO_EXTENSION = [
        'image/png' => 'png',
        'image/jpeg' => 'jpg',
        'image/gif' => 'gif',
        'image/webp' => 'webp',
    ];

    /** Hard cap on the base64 payload (≈33 MB decoded). Stops a hand-crafted
     *  request from writing an unbounded file. */
    public const MAX_BASE64_CHARS = 44_000_000;

    /** Hard cap on decoded bytes (40 MB). */
    public const MAX_BYTES = 40 * 1024 * 1024;

    /** @return array<string, string> mime => extension */
    public static function mimeToExtension(): array
    {
        return self::MIME_TO_EXTENSION;
    }

    public static function isSupportedMime(string $mime): bool
    {
        return isset(self::MIME_TO_EXTENSION[$mime]);
    }

    public static function extensionFor(string $mime): string
    {
        return self::MIME_TO_EXTENSION[$mime] ?? 'bin';
    }

    /**
     * Pull the base64 payload out of a request field: accepts a bare base64
     * string or a full `data:` URI, strips whitespace, enforces the size cap.
     *
     * @param array<string, mixed> $body
     * @param string $field         field to read (checked in order against $aliases)
     * @param list<string> $aliases
     */
    public static function requireBase64(array $body, string $field, array $aliases = []): string
    {
        $raw = null;
        foreach ([$field, ...$aliases] as $key) {
            $candidate = $body[$key] ?? null;
            if (is_string($candidate) && trim($candidate) !== '') {
                $raw = $candidate;
                break;
            }
        }
        if (!is_string($raw) || trim($raw) === '') {
            throw new HttpError($field . ' (base64) is required', 400);
        }

        $clean = trim($raw);
        if (str_starts_with($clean, 'data:')) {
            $comma = strpos($clean, ',');
            if ($comma === false) {
                throw new HttpError('malformed data URI in ' . $field, 400);
            }
            $clean = substr($clean, $comma + 1);
        }
        $clean = str_replace(["\r", "\n", ' '], '', $clean);
        if (strlen($clean) > self::MAX_BASE64_CHARS) {
            throw new HttpError($field . ' too large', 400);
        }
        return $clean;
    }

    /**
     * Decode a base64 payload to raw bytes, enforcing the decoded size cap.
     */
    public static function decode(string $base64, string $field = 'image_data'): string
    {
        $bytes = base64_decode($base64, true);
        if ($bytes === false || $bytes === '') {
            throw new HttpError($field . ' is not valid base64', 400);
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            throw new HttpError('image too large (max 40 MB)', 400);
        }
        return $bytes;
    }

    /**
     * Resolve the mime type of a base64 payload from its actual bytes.
     *
     * The BYTES decide, never the caller's label. Two reasons:
     *
     * 1. A label can be wrong (browsers, proxies and `File.type` all lie
     *    occasionally), and we extend/serve the stored file by its extension —
     *    so jpeg bytes labelled png would be stored as a "png" that nothing can
     *    decode.
     * 2. A label must not be able to smuggle non-image bytes past the gate.
     *    Trusting "image/png" lets `base64_encode('not an image at all')`
     *    through, and you end up with a durable attachment, a note file and a
     *    checksum all claiming to be a picture that cannot be opened — by the
     *    UI, or by the model via look_at_image.
     *
     * Every type in the whitelist has a magic number the sniffer recognises, so
     * "sniff failed" genuinely means "these are not a supported image" rather
     * than "we couldn't tell".
     *
     * Returns null when the payload is not a detectable image.
     */
    public static function resolveMime(string $base64): ?string
    {
        return self::sniff($base64);
    }

    /** Magic-number sniff over the decoded payload. */
    public static function sniff(string $base64): ?string
    {
        $sample = base64_decode(substr($base64, 0, 32), true);
        if (!is_string($sample)) {
            return null;
        }
        if (str_starts_with($sample, "\x89PNG\r\n\x1a\n")) {
            return 'image/png';
        }
        if (str_starts_with($sample, "\xff\xd8\xff")) {
            return 'image/jpeg';
        }
        if (str_starts_with($sample, 'GIF8')) {
            return 'image/gif';
        }
        if (strlen($sample) >= 12 && substr($sample, 0, 4) === 'RIFF' && substr($sample, 8, 4) === 'WEBP') {
            return 'image/webp';
        }
        return null;
    }
}
