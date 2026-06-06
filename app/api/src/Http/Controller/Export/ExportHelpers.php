<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * Shared utility functions for nook export.
 */
final class ExportHelpers
{
    public static function jsonEncode(mixed $data): string
    {
        $encoded = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        return $encoded !== false ? $encoded : 'null';
    }

    public static function humanFilesize(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB'];
        $i = 0;
        $size = (float) $bytes;
        while ($size >= 1024 && $i < count($units) - 1) {
            $size /= 1024;
            $i++;
        }
        return round($size, 1) . ' ' . $units[$i];
    }

    public static function isoDate(string $raw): string
    {
        $ts = strtotime($raw);
        return $ts !== false ? date('Y-m-d\TH:i:s\Z', $ts) : $raw;
    }

    public static function safeFilename(string $name): string
    {
        $safe = preg_replace('/[\/\\\\<>:"|?*\x00-\x1f]/', '-', $name) ?? $name;
        $safe = trim($safe, '. -');
        return $safe !== '' ? $safe : 'Untitled';
    }

    public static function relativePath(string $fromDir, string $toPath): string
    {
        if ($fromDir === '' || $fromDir === '.') {
            return $toPath;
        }

        $fromParts = explode('/', $fromDir);
        $toParts = explode('/', $toPath);

        $common = 0;
        while (
            $common < count($fromParts) && $common < count($toParts) - 1
            && $fromParts[$common] === $toParts[$common]
        ) {
            $common++;
        }

        $ups = count($fromParts) - $common;
        $remaining = array_slice($toParts, $common);

        return implode('/', array_merge(array_fill(0, $ups, '..'), $remaining));
    }

    public static function dataPath(): string
    {
        $raw = getenv('FILES_DATA_PATH');
        $path = is_string($raw) ? trim($raw) : '';
        return $path !== '' ? rtrim($path, '/') : '/data';
    }

    /**
     * Build a display filename from the DB filename + extension fields.
     * Avoids double extension (e.g. "photo.png" + "png" → "photo.png" not "photo.png.png").
     */
    /**
     * Build the zip path for a file attachment.
     * Uses note title + attribute name for human-readable folders.
     */
    public static function buildFileZipPath(
        string $noteTitle,
        ?string $attrName,
        string $fullFilename,
    ): string {
        $safeNote = self::safeFilename($noteTitle ?: 'Untitled');
        if ($attrName) {
            return "files/{$safeNote}/{$attrName}/{$fullFilename}";
        }
        return "files/{$safeNote}/{$fullFilename}";
    }

    public static function buildFilename(string $filename, string $extension): string
    {
        if ($extension === '') {
            return $filename ?: 'file';
        }
        if ($filename === '') {
            return "file.{$extension}";
        }
        // Don't append if filename already ends with the extension
        if (str_ends_with(strtolower($filename), '.' . strtolower($extension))) {
            return $filename;
        }
        return "{$filename}.{$extension}";
    }

    // ── YAML frontmatter ────────────────────────────────────────

    public static function renderFrontmatter(array $data): string
    {
        $yaml = self::yamlEncode($data, 0);
        return "---\n{$yaml}---\n\n";
    }

    public static function yamlEncode(mixed $data, int $indent): string
    {
        if (is_array($data) && array_is_list($data)) {
            if (empty($data)) {
                return "[]\n";
            }
            $out = '';
            $pad = str_repeat('  ', $indent);
            foreach ($data as $item) {
                if (is_array($item)) {
                    $out .= "{$pad}- " . ltrim(self::yamlEncode($item, $indent + 1));
                } else {
                    $out .= "{$pad}- " . self::yamlScalar($item) . "\n";
                }
            }
            return $out;
        }

        if (is_array($data)) {
            if (empty($data)) {
                return "{}\n";
            }
            $out = '';
            $pad = str_repeat('  ', $indent);
            foreach ($data as $key => $value) {
                $safeKey = self::yamlScalar((string) $key);
                if (is_array($value)) {
                    $out .= "{$pad}{$safeKey}:\n" . self::yamlEncode($value, $indent + 1);
                } else {
                    $out .= "{$pad}{$safeKey}: " . self::yamlScalar($value) . "\n";
                }
            }
            return $out;
        }

        return self::yamlScalar($data) . "\n";
    }

    public static function yamlScalar(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if ($value === true) {
            return 'true';
        }
        if ($value === false) {
            return 'false';
        }
        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }
        if (!is_string($value)) {
            return '""';
        }
        $s = $value;
        if (
            $s === '' || preg_match('/^[\d.eE+-]|^(true|false|null|yes|no)$/i', $s)
            || preg_match('/[:{}\[\],&#*?|>!%@`\n]/', $s)
            || str_starts_with($s, '- ') || str_starts_with($s, '# ')
        ) {
            return '"' . addcslashes($s, "\"\\\n\r\t") . '"';
        }
        return $s;
    }

    /**
     * Build type ID → folder path mapping (e.g. "Note/Meeting").
     *
     * @param array<string, array{id: string, label: string, parent_id: ?string}> $typeById
     * @return array<string, string>
     */
    public static function buildTypeFolders(array $typeById): array
    {
        $folders = [];
        foreach ($typeById as $id => $type) {
            $parts = [self::safeFilename($type['label'])];
            $parentId = $type['parent_id'] ?? null;
            $seen = [$id => true];
            while ($parentId && isset($typeById[$parentId]) && !isset($seen[$parentId])) {
                $seen[$parentId] = true;
                $parts[] = self::safeFilename($typeById[$parentId]['label']);
                $parentId = $typeById[$parentId]['parent_id'] ?? null;
            }
            $folders[$id] = implode('/', array_reverse($parts));
        }
        return $folders;
    }
}
