<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\Files;

use Paith\Notes\Api\Http\HttpError;

/**
 * Bytes on the local disk, addressed by `object_key`.
 *
 * The API stores note files and chat attachments as plain files under
 * FILES_DATA_PATH, keyed by an object_key path (`notes/…/v1`,
 * `chat/…/n.png`). Every controller that touches those bytes goes through here
 * so the root-path resolution and the "never blow away a file outside the data
 * root" rule live in exactly one place.
 */
final class LocalObjectStore
{
    public static function dataPath(): string
    {
        $path = trim((string)getenv('FILES_DATA_PATH'));
        return $path !== '' ? rtrim($path, '/') : '/data';
    }

    /**
     * Absolute path for an object_key. Rejects keys that try to escape the data
     * root (`..`, absolute paths) — they would otherwise let a stored key read
     * or overwrite arbitrary files.
     */
    public static function pathFor(string $objectKey): string
    {
        $key = ltrim($objectKey, '/');
        if ($key === '' || str_contains($key, '..')) {
            throw new HttpError('invalid object key', 400);
        }
        return self::dataPath() . '/' . $key;
    }

    public static function write(string $objectKey, string $bytes): void
    {
        $path = self::pathFor($objectKey);
        $dir = dirname($path);
        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0777, true) && !is_dir($dir)) {
                throw new HttpError('failed to create storage dir: ' . self::lastErrorMessage(), 500);
            }
        }
        if (@file_put_contents($path, $bytes) === false) {
            throw new HttpError('failed to write bytes: ' . self::lastErrorMessage(), 500);
        }
    }

    public static function read(string $objectKey): string
    {
        $bytes = @file_get_contents(self::pathFor($objectKey));
        if ($bytes === false) {
            throw new HttpError('stored bytes are missing', 404);
        }
        return $bytes;
    }

    public static function exists(string $objectKey): bool
    {
        return @is_file(self::pathFor($objectKey));
    }

    /**
     * Best-effort delete. Returns false when the file was already gone — callers
     * clean up rows in bulk and don't want a missing file to abort the sweep.
     */
    public static function delete(string $objectKey): bool
    {
        $path = self::pathFor($objectKey);
        if (!@is_file($path)) {
            return false;
        }
        return @unlink($path);
    }

    /**
     * Delete every object under a key prefix, then prune the now-empty
     * directories. Used when a conversation (and all its attachments) is
     * deleted: the DB cascade removes the rows, this removes the bytes.
     */
    public static function deletePrefix(string $prefix): int
    {
        $base = self::pathFor($prefix);
        if (!@is_dir($base)) {
            return 0;
        }
        $deleted = 0;
        $entries = @scandir($base);
        if ($entries === false) {
            return 0;
        }
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $base . '/' . $entry;
            if (@is_dir($path)) {
                $deleted += self::deletePrefix(ltrim($prefix, '/') . '/' . $entry);
                if (self::isEmptyDir($path)) {
                    @rmdir($path);
                }
                continue;
            }
            if (@unlink($path)) {
                $deleted++;
            }
        }
        return $deleted;
    }

    /**
     * Delete every object under a prefix AND the prefix directory itself, then
     * climb out removing any parent directories the sweep left empty (never the
     * data root).
     *
     * This is what a delete of one conversation's attachments needs: the DB
     * cascade removes the rows, and after this call nothing at all remains under
     * `chat/` — not the bytes, not `chat/{id}/images`, not the empty
     * `chat/{id}/` or `chat/` shells. Empty shells would otherwise accumulate for
     * the lifetime of the install, one per deleted conversation.
     *
     * Climbing stops at the first directory that is still non-empty, so
     * `chat/` survives as long as another conversation still has attachments.
     *
     * @return int number of files deleted
     */
    public static function deleteTree(string $prefix): int
    {
        $deleted = self::deletePrefix($prefix);

        $base = self::pathFor($prefix);
        if (self::isEmptyDir($base)) {
            @rmdir($base); // only when the sweep emptied it
        }

        $root = self::dataPath();
        $dir = dirname($base);
        while ($dir !== $root && str_starts_with($dir, $root . '/')) {
            // Test emptiness BEFORE rmdir instead of using rmdir's failure as
            // control flow: a non-empty directory raises a warning that PHPUnit
            // reports even through @, and "still in use by another conversation"
            // is the normal case here, not an error.
            if (!self::isEmptyDir($dir)) {
                return $deleted;
            }
            if (!@rmdir($dir)) {
                return $deleted; // lost a race with a concurrent write
            }
            $dir = dirname($dir);
        }

        return $deleted;
    }

    /**
     * True only when the path is an existing directory with no entries left.
     *
     * Strict on purpose: a missing directory is NOT empty. Callers use this to
     * decide whether to rmdir, and rmdir on a path that isn't there is a warning
     * (which PHPUnit reports even through @) — and a conversation that never had
     * an attachment simply has no directory at all, which is the common case.
     */
    private static function isEmptyDir(string $path): bool
    {
        if (!@is_dir($path)) {
            return false;
        }
        $entries = @scandir($path);
        // scandir always includes '.' and '..' for a readable directory.
        return is_array($entries) && count($entries) === 2;
    }

    private static function lastErrorMessage(): string
    {
        $err = error_get_last();
        return is_array($err) ? $err['message'] : 'unknown error';
    }
}
