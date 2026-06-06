<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * Builds a single note's markdown file: frontmatter + rendered attributes + content.
 */
final class NoteMarkdownWriter
{
    /** Attribute kinds that carry user data and belong in frontmatter. */
    private const FRONTMATTER_KINDS = [
        'text', 'number', 'boolean', 'date', 'date_range',
        'select', 'multi_select', 'url',
    ];

    /**
     * Render a complete .md file for a note.
     *
     * @param array<string, mixed> $note          DB row: id, title, content, type_id, created_by, created_at, updated_at, version, attributes
     * @param array<string, mixed> $lookups       Shared lookup tables (typeById, attrById, attrList, noteMap, noteTitles, noteFiles, linksBySource, mentionsBySource, userNames, lastUpdaters, typeFolders)
     * @return string  Full markdown with frontmatter
     */
    public static function render(array $note, array $lookups): string
    {
        $id = (string) $note['id'];
        $title = (string) ($note['title'] ?: 'Untitled');
        $content = (string) ($note['content'] ?? '');
        $rawAttrs = is_string($note['attributes'] ?? null)
            ? json_decode($note['attributes'], true)
            : ($note['attributes'] ?? []);
        if (!is_array($rawAttrs)) {
            $rawAttrs = [];
        }

        $noteMap = $lookups['noteMap'];
        $noteTitles = $lookups['noteTitles'];
        $noteDir = dirname($noteMap[$id] ?? '');
        if ($noteDir === '.') {
            $noteDir = '';
        }

        $typeById = $lookups['typeById'];
        $attrById = $lookups['attrById'];
        $attrList = $lookups['attrList'];
        $noteFiles = $lookups['noteFiles'];
        $linksBySource = $lookups['linksBySource'];
        $mentionsBySource = $lookups['mentionsBySource'];
        $userNames = $lookups['userNames'];
        $lastUpdaters = $lookups['lastUpdaters'];

        // ── Build frontmatter ───────────────────────────────────
        $fm = [
            'id' => $id,
            'title' => $title,
        ];

        $typeId = $note['type_id'] ?? null;
        if ($typeId && isset($typeById[$typeId])) {
            $fm['type'] = $typeById[$typeId]['label'];
        }

        $fm['version'] = (int) ($note['version'] ?? 0);
        // `date` for Hugo/SSG compatibility, plus our own timestamps
        if (!empty($note['created_at'])) {
            $iso = ExportHelpers::isoDate($note['created_at']);
            $fm['date'] = $iso;
            $fm['created_at'] = $iso;
        }
        if (!empty($note['updated_at'])) {
            $fm['updated_at'] = ExportHelpers::isoDate($note['updated_at']);
            $fm['lastmod'] = $fm['updated_at']; // Hugo convention
        }
        $fm['draft'] = false;

        $creatorId = $note['created_by'] ?? null;
        if ($creatorId && isset($userNames[$creatorId])) {
            $fm['created_by'] = $userNames[$creatorId];
        }
        $updaterId = $lastUpdaters[$id] ?? null;
        if ($updaterId && isset($userNames[$updaterId])) {
            $fm['updated_by'] = $userNames[$updaterId];
        }

        // Simple attributes
        $fmAttrs = self::buildFrontmatterAttrs($rawAttrs, $attrById);
        if ($fmAttrs) {
            $fm['attributes'] = $fmAttrs;
        }

        // Links
        $noteLinks = $linksBySource[$id] ?? [];
        if ($noteLinks) {
            $grouped = [];
            foreach ($noteLinks as $link) {
                $targetTitle = $noteTitles[$link['target_id']] ?? $link['target_id'];
                $grouped[$link['predicate']][] = $targetTitle;
            }
            $fm['links'] = $grouped;
        }

        // Mentions
        $noteMentions = $mentionsBySource[$id] ?? [];
        if ($noteMentions) {
            $fm['mentions'] = array_map(fn($mid) => $noteTitles[$mid] ?? $mid, $noteMentions);
        }

        // Files in frontmatter
        $fmFiles = self::buildFrontmatterFiles($id, $title, $noteFiles, $attrById);
        if ($fmFiles) {
            $fm['files'] = $fmFiles;
        }

        // ── Rewrite content links ───────────────────────────────
        $appBaseUrl = $lookups['appBaseUrl'] ?? '';
        $rewrittenContent = NoteLinker::rewriteToRelative($content, $noteMap, $noteTitles, $noteDir, $noteFiles, $attrById, $appBaseUrl);

        // ── Render attributes around content ────────────────────
        $typeAttrDefs = $typeId ? array_values(array_filter($attrList, fn($a) => $a['type_id'] === $typeId)) : [];
        $renderCtx = [
            'note_id' => $id,
            'noteMap' => $noteMap,
            'noteTitles' => $noteTitles,
            'noteDir' => $noteDir,
            'noteFiles' => $noteFiles,
            'attrById' => $attrById,
            'linksBySource' => $linksBySource,
            'mentionsBySource' => $mentionsBySource,
        ];
        $split = AttributeMarkdownRenderer::renderSplit($rawAttrs, $typeAttrDefs, $renderCtx);

        $md = ExportHelpers::renderFrontmatter($fm);
        if ($split['before'] !== '') {
            $md .= $split['before'];
        }
        $md .= "<!-- paith:content -->\n\n";
        $md .= $rewrittenContent;
        $md .= "\n\n<!-- /paith:content -->";
        if ($split['after'] !== '') {
            $md .= $split['after'];
        }
        return $md;
    }

    /**
     * Build human-readable attribute map for frontmatter (simple kinds only).
     */
    private static function buildFrontmatterAttrs(array $rawAttrs, array $attrById): array
    {
        $out = [];
        foreach ($rawAttrs as $attrId => $value) {
            if ($value === null) {
                continue;
            }
            $def = $attrById[$attrId] ?? null;
            if (!$def) {
                continue;
            }
            if (!in_array($def['kind'], self::FRONTMATTER_KINDS, true)) {
                continue;
            }
            $out[$def['name']] = $value;
        }
        return $out;
    }

    /**
     * Build file entries for frontmatter.
     */
    private static function buildFrontmatterFiles(string $noteId, string $noteTitle, array $noteFiles, array $attrById): array
    {
        $files = $noteFiles[$noteId] ?? [];
        if (empty($files)) {
            return [];
        }

        $out = [];
        foreach ($files as $f) {
            $filename = (string) ($f['filename'] ?? 'file');
            $ext = (string) ($f['extension'] ?? '');
            $fullFilename = ExportHelpers::buildFilename($filename, $ext);
            $mime = (string) ($f['mime_type'] ?? '');

            $attrName = null;
            if (isset($f['attribute_id'], $attrById[$f['attribute_id']])) {
                $attrName = ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name']);
            }
            $fileZipPath = ExportHelpers::buildFileZipPath($noteTitle, $attrName, $fullFilename);

            $out[] = [
                'path' => $fileZipPath,
                'filename' => $fullFilename,
                'mime_type' => $mime,
                'size' => ExportHelpers::humanFilesize((int) ($f['filesize'] ?? 0)),
            ];
        }
        return $out;
    }
}
