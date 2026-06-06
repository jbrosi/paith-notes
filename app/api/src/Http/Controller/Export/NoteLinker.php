<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * Rewrites note links between internal [[note:uuid]] format and relative markdown paths.
 * Handles both same-nook and cross-nook links.
 */
final class NoteLinker
{
    private const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    /**
     * Rewrite [[note:uuid]], [[note:nookId/noteId]], and ![](note:...) to relative or absolute links.
     *
     * Same-nook links → relative .md paths
     * Cross-nook links → absolute app URLs
     * Image embeds → actual file paths when available
     *
     * @param string                     $content     Note markdown content
     * @param array<string, string>      $noteMap     uuid → .md path (same-nook notes)
     * @param array<string, string>      $noteTitles  uuid → title (same-nook notes)
     * @param string                     $currentDir  directory of current note (relative to notes/)
     * @param array<string, list<array>> $noteFiles   note_id → file metadata rows
     * @param array<string, array>       $attrById    attribute id → { name, kind }
     * @param string                     $appBaseUrl  Base URL for cross-nook absolute links
     */
    public static function rewriteToRelative(
        string $content,
        array $noteMap,
        array $noteTitles,
        string $currentDir,
        array $noteFiles = [],
        array $attrById = [],
        string $appBaseUrl = '',
    ): string {
        $uuid = self::UUID;

        // Combined pattern: cross-nook wikilink, same-nook wikilink, cross-nook image, same-nook image
        $pattern = '/
            \[\[note:(' . $uuid . ')\/(' . $uuid . ')\]\]                    # cross-nook wikilink: [[note:nookId\/noteId]]
            | \[\[note:(' . $uuid . ')\]\]                                     # same-nook wikilink: [[note:noteId]]
            | (\!\[[^\]]*\])\(note:(' . $uuid . ')\/(' . $uuid . ')\)         # cross-nook image: ![alt](note:nookId\/noteId)
            | (\!\[[^\]]*\])\(note:(' . $uuid . ')\)                           # same-nook image: ![alt](note:noteId)
        /xi';

        return preg_replace_callback(
            $pattern,
            static function (array $m) use ($noteMap, $noteTitles, $currentDir, $noteFiles, $attrById, $appBaseUrl): string {
                // Cross-nook wikilink: [[note:nookId/noteId]]
                if (!empty($m[1]) && !empty($m[2])) {
                    $nookId = $m[1];
                    $noteId = $m[2];
                    $url = $appBaseUrl ? "{$appBaseUrl}/nooks/{$nookId}/notes/{$noteId}" : "#";
                    $title = $noteTitles[$noteId] ?? substr($noteId, 0, 8) . '…';
                    return "[{$title}]({$url})";
                }

                // Same-nook wikilink: [[note:uuid]]
                if (!empty($m[3])) {
                    $uuid = $m[3];
                    $targetPath = $noteMap[$uuid] ?? null;
                    $title = $noteTitles[$uuid] ?? $uuid;
                    if ($targetPath) {
                        $rel = ExportHelpers::relativePath($currentDir, $targetPath);
                        return "[{$title}]({$rel})";
                    }
                    return "[{$title}]()";
                }

                // Cross-nook image: ![alt](note:nookId/noteId)
                if (!empty($m[4]) && !empty($m[5]) && !empty($m[6])) {
                    $altPart = $m[4];
                    $nookId = $m[5];
                    $noteId = $m[6];
                    $url = $appBaseUrl ? "{$appBaseUrl}/nooks/{$nookId}/notes/{$noteId}" : "#";
                    return "{$altPart}({$url})";
                }

                // Same-nook image: ![alt](note:uuid) → point to actual file
                if (!empty($m[7]) && !empty($m[8])) {
                    $altPart = $m[7];
                    $uuid = $m[8];

                    // Try actual file on disk
                    $files = $noteFiles[$uuid] ?? [];
                    if ($files) {
                        $f = $files[0];
                        $filename = (string) ($f['filename'] ?? 'file');
                        $ext = (string) ($f['extension'] ?? '');
                        $fullFilename = $ext !== '' ? "{$filename}.{$ext}" : $filename;
                        $attrName = null;
                        if (isset($f['attribute_id'], $attrById[$f['attribute_id']])) {
                            $attrName = ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name']);
                        }
                        $fileZipPath = $attrName
                            ? "files/{$uuid}/{$attrName}/{$fullFilename}"
                            : "files/{$uuid}/{$fullFilename}";
                        $rel = ExportHelpers::relativePath("notes/{$currentDir}", $fileZipPath);
                        return "{$altPart}({$rel})";
                    }

                    // Fallback: link to note .md
                    $targetPath = $noteMap[$uuid] ?? null;
                    if ($targetPath) {
                        $rel = ExportHelpers::relativePath($currentDir, $targetPath);
                        return "{$altPart}({$rel})";
                    }
                    return $m[0];
                }

                return $m[0];
            },
            $content,
        ) ?? $content;
    }

    /**
     * Rewrite relative markdown links back to [[note:uuid]] format (for reimport).
     *
     * @param string                $content       Note markdown content
     * @param string                $currentEntry  Zip entry path (e.g. "notes/Note/Meeting/Standup.md")
     * @param array<string, string> $pathToId      path → uuid
     */
    public static function rewriteToInternal(string $content, string $currentEntry, array $pathToId): string
    {
        $notePath = preg_replace('#^notes/#', '', $currentEntry);
        $currentDir = dirname($notePath);
        if ($currentDir === '.') $currentDir = '';

        return preg_replace_callback(
            '/\[([^\]]*)\]\(([^)]+\.md)\)/',
            static function (array $m) use ($currentDir, $pathToId): string {
                $relPath = $m[2];
                $absPath = self::resolveRelativePath($currentDir, $relPath);
                if (isset($pathToId[$absPath])) {
                    return "[[note:{$pathToId[$absPath]}]]";
                }
                return $m[0];
            },
            $content,
        ) ?? $content;
    }

    private static function resolveRelativePath(string $fromDir, string $relPath): string
    {
        $parts = $fromDir !== '' ? explode('/', $fromDir) : [];
        foreach (explode('/', $relPath) as $segment) {
            if ($segment === '..') {
                array_pop($parts);
            } elseif ($segment !== '.' && $segment !== '') {
                $parts[] = $segment;
            }
        }
        return implode('/', $parts);
    }
}
