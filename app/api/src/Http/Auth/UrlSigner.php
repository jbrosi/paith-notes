<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

use Paith\Notes\Shared\Env;

/**
 * HMAC-SHA256 signer for file download URLs.
 *
 * Mirrored byte-for-byte by the qjs handler in docker/files/njs/files-auth.mjs
 * so nginx can verify a signed download without round-tripping to PHP. Range
 * requests for media streaming reuse the same signature.
 *
 * Canonical input is newline-joined fields (order matters):
 *
 *   objectKey + "\n" + exp + "\n" + sessionId + "\n"
 *     + filename + "\n" + contentType + "\n" + inline
 *
 * Where:
 *   - objectKey:   path after /files/ (e.g. "notes/<uuid>/files/<uuid>/<uuid>/v1")
 *   - exp:         unix timestamp the URL is valid until
 *   - sessionId:   value of the paith_session cookie. Empty for anonymous embeds.
 *                  Including it here makes a leaked URL useless without the
 *                  issuing browser's cookie.
 *   - filename:    original filename, used for Content-Disposition
 *   - contentType: MIME type, used for Content-Type
 *   - inline:      "1" or "0" — Content-Disposition: inline vs attachment
 *
 * Output is base64url-encoded (RFC 4648 §5), no padding.
 */
final class UrlSigner
{
    public function __construct(private readonly string $key)
    {
    }

    public static function fromEnv(): self
    {
        return new self(Env::require('FILES_SIGNING_KEY'));
    }

    public function sign(
        string $objectKey,
        int $exp,
        string $sessionId,
        string $filename,
        string $contentType,
        bool $inline,
    ): string {
        $canonical = self::canonical($objectKey, $exp, $sessionId, $filename, $contentType, $inline);
        return self::base64UrlEncode(hash_hmac('sha256', $canonical, $this->key, true));
    }

    public function verify(
        string $signature,
        string $objectKey,
        int $exp,
        string $sessionId,
        string $filename,
        string $contentType,
        bool $inline,
    ): bool {
        $expected = $this->sign($objectKey, $exp, $sessionId, $filename, $contentType, $inline);
        return hash_equals($expected, $signature);
    }

    private static function canonical(
        string $objectKey,
        int $exp,
        string $sessionId,
        string $filename,
        string $contentType,
        bool $inline,
    ): string {
        return implode("\n", [
            $objectKey,
            (string)$exp,
            $sessionId,
            $filename,
            $contentType,
            $inline ? '1' : '0',
        ]);
    }

    private static function base64UrlEncode(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
