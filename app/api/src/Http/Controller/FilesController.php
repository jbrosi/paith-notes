<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\Cookies;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\TextResponse;
use PDO;

final class FilesController
{
    private function guessMimeTypeFromExtension(string $ext): string
    {
        $ext = strtolower(trim($ext));
        $ext = ltrim($ext, '.');
        if ($ext === '') {
            return '';
        }

        return match ($ext) {
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'bmp' => 'image/bmp',
            'tif', 'tiff' => 'image/tiff',
            'pdf' => 'application/pdf',
            default => '',
        };
    }

    private function normalizeMimeType(string $mime): string
    {
        $mime = strtolower(trim($mime));
        if ($mime === '') {
            return '';
        }
        $semi = strpos($mime, ';');
        if ($semi !== false) {
            $mime = trim(substr($mime, 0, $semi));
        }
        return $mime;
    }

    private function isSafeInlineMimeType(string $mime): bool
    {
        $mime = $this->normalizeMimeType($mime);
        if ($mime === '') {
            return false;
        }

        // Allowlist only. Important: disallow SVG since it can execute scripts in some contexts.
        // Also disallow any text/*, html, javascript, wasm, etc.
        return in_array($mime, [
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'image/bmp',
            'image/tiff',
            'application/pdf',
        ], true);
    }

    public function auth(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $cookieHeader = $request->header('Cookie');

        $method = strtoupper(trim($request->header('X-Original-Method')));
        if ($method === '') {
            $method = strtoupper($request->method());
        }

        $originalUri = trim($request->header('X-Original-URI'));
        if ($originalUri === '') {
            throw new HttpError('missing X-Original-URI', 400);
        }

        $path = parse_url($originalUri, PHP_URL_PATH);
        $path = is_string($path) ? $path : '';

        $qs = parse_url($originalUri, PHP_URL_QUERY);
        $qs = is_string($qs) ? $qs : '';
        $originalQuery = [];
        if ($qs !== '') {
            parse_str($qs, $originalQuery);
        }

        if (!str_starts_with($path, '/files/')) {
            throw new HttpError('invalid path', 400);
        }

        $objectKey = ltrim(substr($path, strlen('/files/')), '/');
        if ($objectKey === '') {
            throw new HttpError('invalid object', 404);
        }

        $requestedExt = '';

        // Allow optional extensions in the public URL (e.g. .../files/<uuid>.png)
        // so that nginx can infer Content-Type from the request URI even if the stored object
        // has no extension.
        $lastSlash = strrpos($objectKey, '/');
        $base = $lastSlash === false ? $objectKey : substr($objectKey, $lastSlash + 1);
        $dot = strrpos($base, '.');
        if ($dot !== false && $dot > 0) {
            $requestedExt = substr($base, $dot + 1);
            $objectKey = $lastSlash === false
                ? substr($objectKey, 0, strlen($base) - (strlen($base) - $dot))
                : substr($objectKey, 0, $lastSlash + 1) . substr($base, 0, $dot);
        }

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            // auth_request wants 401 for unauthenticated
            throw new HttpError('unauthenticated', 401);
        }

        if ($method === 'PUT') {
            return $this->authorizeTempPut($pdo, $userId, $objectKey, $cookieHeader);
        }

        if ($method !== 'GET' && $method !== 'HEAD') {
            throw new HttpError('method not allowed', 405);
        }

        $stmt = $pdo->prepare(
            "select nf.filename, nf.mime_type\n"
            . "from global.note_files nf\n"
            . "join global.notes n on n.id = nf.note_id\n"
            . "join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id\n"
            . "where nf.object_key = :object_key\n"
            . "limit 1"
        );
        $stmt->execute([
            ':user_id' => $userId,
            ':object_key' => $objectKey,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            // returning 404 here prevents leaking existence to non-members
            throw new HttpError('not found', 404);
        }

        $filename = is_scalar($row['filename'] ?? null) ? (string)$row['filename'] : 'download';
        $mimeType = is_scalar($row['mime_type'] ?? null) ? (string)$row['mime_type'] : '';
        $mimeType = $this->normalizeMimeType($mimeType);
        if ($mimeType === '' && $requestedExt !== '') {
            $mimeType = $this->guessMimeTypeFromExtension($requestedExt);
        }

        $inlineRaw = $originalQuery['inline'] ?? '';
        $inlineRequested = is_scalar($inlineRaw) && trim((string)$inlineRaw) !== '';
        $inlineAllowed = $inlineRequested && $this->isSafeInlineMimeType($mimeType);

        // Never serve unsafe types inline, even if the client requested inline.
        $disposition = $this->contentDispositionHeader($filename, $inlineAllowed);

        // If it's not safe for inline, prefer a generic type to reduce chances of content sniffing.
        $effectiveType = $inlineAllowed ? $mimeType : 'application/octet-stream';

        return new TextResponse('', 200, [
            // nginx auth_request can read these as $upstream_http_x_notes_*
            'X-Notes-Content-Disposition' => $disposition,
            'X-Notes-Content-Type' => $effectiveType,
        ]);
    }

    private function authorizeTempPut(PDO $pdo, string $userId, string $objectKey, string $cookieHeader): Response
    {
        if (!str_starts_with($objectKey, 'tmp/')) {
            throw new HttpError('not found', 404);
        }

        $tmpKey = $objectKey;

        $stmt = $pdo->prepare(
            "select session_id, put_claimed_at\n"
            . "from global.file_uploads\n"
            . "where created_by = :user_id and temp_object_key = :temp_object_key and finalized_at is null and expires_at > now()\n"
            . "limit 1"
        );
        $stmt->execute([
            ':user_id' => $userId,
            ':temp_object_key' => $tmpKey,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('not found', 404);
        }

        $rowSession = $row['session_id'] ?? null;
        $putClaimedAt = $row['put_claimed_at'] ?? null;

        // If session_id is set on the upload, require it to match the current cookie.
        if (is_scalar($rowSession) && (string)$rowSession !== '') {
            $sid = $this->sessionIdFromRequestCookieHeader($cookieHeader);
            if ($sid === '' || $sid !== (string)$rowSession) {
                throw new HttpError('not authorized', 403);
            }
        }

        // Claim the upload on the first successful PUT auth. Subsequent PUT auth calls are denied.
        if (!is_scalar($putClaimedAt) || trim((string)$putClaimedAt) === '') {
            $claim = $pdo->prepare(
                "update global.file_uploads\n"
                . "set put_claimed_at = now()\n"
                . "where created_by = :user_id and temp_object_key = :temp_object_key and finalized_at is null and expires_at > now() and put_claimed_at is null"
            );
            $claim->execute([
                ':user_id' => $userId,
                ':temp_object_key' => $tmpKey,
            ]);
            if ($claim->rowCount() !== 1) {
                throw new HttpError('upload already used', 409);
            }
        } else {
            throw new HttpError('upload already used', 409);
        }

        // Don't emit download headers for uploads.
        return new TextResponse('', 200, []);
    }

    private function sessionIdFromRequestCookieHeader(string $cookieHeader): string
    {
        $cookieHeader = trim($cookieHeader);
        if ($cookieHeader === '') {
            return '';
        }
        $cookies = Cookies::parseCookieHeader($cookieHeader);
        $sid = $cookies[SessionStore::cookieName()] ?? '';
        return trim($sid);
    }

    private function contentDispositionHeader(string $filename, bool $inline): string
    {
        $type = $inline ? 'inline' : 'attachment';

        $fallback = $this->sanitizeAsciiFilename($filename);
        $encoded = rawurlencode($filename);

        return $type . '; filename="' . $fallback . '"; filename*=UTF-8\'\'' . $encoded;
    }

    private function sanitizeAsciiFilename(string $filename): string
    {
        $filename = trim($filename);
        if ($filename === '') {
            return 'download';
        }

        // remove path separators and control chars
        $filename = str_replace(['\\\\', '/', "\0"], '-', $filename);
        $filename = preg_replace('/[\x00-\x1F\x7F]+/', '', $filename);
        if (!is_string($filename)) {
            $filename = 'download';
        }

        // keep it simple to avoid header injection / quoting issues
        $filename = str_replace(['"', "'"], '', $filename);

        if ($filename === '') {
            return 'download';
        }

        return $filename;
    }
}
