<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

use Paith\Notes\Shared\Db\Row;

/**
 * Builds a single note's markdown file: frontmatter + rendered attributes + content.
 *
 * @phpstan-import-type Lookups from ExportTypes
 * @phpstan-import-type RenderContext from ExportTypes
 * @phpstan-import-type AttrRow from ExportTypes
 * @phpstan-import-type FileRow from ExportTypes
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
     * @param array<string, mixed> $note     DB row: id, title, content, type_id, created_by, created_at, updated_at, version, attributes
     * @param Lookups              $lookups  Shared lookup tables built by NookExportController
     * @return string  Full markdown with frontmatter
     */
    public static function render(array $note, array $lookups): string
    {
        $id = Row::requireStr($note, 'id');
        $titleRaw = Row::str($note, 'title');
        $title = $titleRaw !== '' ? $titleRaw : 'Untitled';
        $content = Row::str($note, 'content');

        $rawAttrs = Row::decodeJsonObject($note['attributes'] ?? null);

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

        $typeId = Row::nullStr($note, 'type_id');
        if ($typeId !== null && isset($typeById[$typeId])) {
            $fm['type'] = $typeById[$typeId]['label'];
        }

        $fm['version'] = Row::int($note, 'version');
        // `date` for Hugo/SSG compatibility, plus our own timestamps
        $createdAt = Row::str($note, 'created_at');
        if ($createdAt !== '') {
            $iso = ExportHelpers::isoDate($createdAt);
            $fm['date'] = $iso;
            $fm['created_at'] = $iso;
        }
        $updatedAt = Row::str($note, 'updated_at');
        if ($updatedAt !== '') {
            $fm['updated_at'] = ExportHelpers::isoDate($updatedAt);
            $fm['lastmod'] = $fm['updated_at']; // Hugo convention
        }
        $fm['draft'] = false;

        $creatorId = Row::str($note, 'created_by');
        if ($creatorId !== '' && isset($userNames[$creatorId])) {
            $fm['created_by'] = $userNames[$creatorId];
        }
        $updaterId = $lastUpdaters[$id] ?? '';
        if ($updaterId !== '' && isset($userNames[$updaterId])) {
            $fm['updated_by'] = $userNames[$updaterId];
        }

        // Simple attributes
        $fmAttrs = self::buildFrontmatterAttrs($rawAttrs, $attrById);
        if ($fmAttrs !== []) {
            $fm['attributes'] = $fmAttrs;
        }

        // Links
        $noteLinks = $linksBySource[$id] ?? [];
        if ($noteLinks !== []) {
            $grouped = [];
            foreach ($noteLinks as $link) {
                $targetTitle = $noteTitles[$link['target_id']] ?? $link['target_id'];
                $grouped[$link['predicate']][] = $targetTitle;
            }
            $fm['links'] = $grouped;
        }

        // Mentions
        $noteMentions = $mentionsBySource[$id] ?? [];
        if ($noteMentions !== []) {
            $fm['mentions'] = array_map(fn($mid) => $noteTitles[$mid] ?? $mid, $noteMentions);
        }

        // Files in frontmatter
        $fmFiles = self::buildFrontmatterFiles($id, $title, $noteFiles, $attrById);
        if ($fmFiles !== []) {
            $fm['files'] = $fmFiles;
        }

        // ── Rewrite content links ───────────────────────────────
        $appBaseUrl = $lookups['appBaseUrl'];
        $rewrittenContent = NoteLinker::rewriteToRelative($content, $noteMap, $noteTitles, $noteDir, $noteFiles, $attrById, $appBaseUrl);

        // ── Render attributes around content ────────────────────
        $typeAttrDefs = $typeId !== null ? array_values(array_filter($attrList, fn($a) => $a['type_id'] === $typeId)) : [];
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
     *
     * @param array<string, mixed>      $rawAttrs
     * @param array<string, AttrRow>    $attrById
     * @return array<string, mixed>
     */
    private static function buildFrontmatterAttrs(array $rawAttrs, array $attrById): array
    {
        $out = [];
        foreach ($rawAttrs as $attrId => $value) {
            if ($value === null) {
                continue;
            }
            $def = $attrById[$attrId] ?? null;
            if ($def === null) {
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
     *
     * @param array<string, list<FileRow>> $noteFiles
     * @param array<string, AttrRow>       $attrById
     * @return list<array{path: string, filename: string, mime_type: string, size: string}>
     */
    private static function buildFrontmatterFiles(string $noteId, string $noteTitle, array $noteFiles, array $attrById): array
    {
        $files = $noteFiles[$noteId] ?? [];
        if ($files === []) {
            return [];
        }

        $out = [];
        foreach ($files as $f) {
            $fullFilename = ExportHelpers::buildFilename($f['filename'], $f['extension']);

            $attrName = null;
            if ($f['attribute_id'] !== null && isset($attrById[$f['attribute_id']])) {
                $attrName = ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name']);
            }
            $fileZipPath = ExportHelpers::buildFileZipPath($noteTitle, $attrName, $fullFilename);

            $out[] = [
                'path' => $fileZipPath,
                'filename' => $fullFilename,
                'mime_type' => $f['mime_type'],
                'size' => ExportHelpers::humanFilesize($f['filesize']),
            ];
        }
        return $out;
    }
}
