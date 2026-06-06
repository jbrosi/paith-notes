<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * Renders dashboard, index, unlinked, and README pages for export.
 */
final class DashboardRenderer
{
    /**
     * Root dashboard index.md — notes grouped by type, stats, recent notes.
     */
    public static function buildDashboard(
        string $nookName,
        array $typeList,
        array $typeFolders,
        array $notesByFolder,
        array $noteMap,
        array $noteTitles,
        array $linkList,
        array $stats,
    ): string {
        $md = "# {$nookName}\n\n";
        $md .= "| | Count |\n|---|---|\n";
        $md .= "| Notes | {$stats['notes']} |\n";
        $md .= "| Types | {$stats['types']} |\n";
        $md .= "| Links | {$stats['links']} |\n";
        $md .= "| Files | {$stats['files']} |\n\n";

        // Notes grouped by type (root types first)
        $rootTypes = array_filter($typeList, fn($t) => empty($t['parent_id']));
        if ($rootTypes) {
            $md .= "## By Type\n\n";
            foreach ($rootTypes as $type) {
                $folder = $typeFolders[$type['id']] ?? null;
                if ($folder === null) continue;
                $folderNotes = $notesByFolder[$folder] ?? [];
                $count = count($folderNotes);

                // Count subtypes
                $childCount = 0;
                foreach ($typeList as $t) {
                    if (($t['parent_id'] ?? '') === $type['id']) {
                        $cf = $typeFolders[$t['id']] ?? '';
                        $childCount += count($notesByFolder[$cf] ?? []);
                    }
                }
                $total = $count + $childCount;

                $md .= "- [{$type['label']}]({$folder}/_index.md) ({$total} note" . ($total !== 1 ? 's' : '') . ")\n";

                foreach ($typeList as $t) {
                    if (($t['parent_id'] ?? '') !== $type['id']) continue;
                    $cf = $typeFolders[$t['id']] ?? '';
                    $cn = count($notesByFolder[$cf] ?? []);
                    $md .= "  - [{$t['label']}]({$cf}/_index.md) ({$cn})\n";
                }
            }
        }

        // Untyped notes
        $untypedNotes = $notesByFolder[''] ?? [];
        if ($untypedNotes) {
            $md .= "\n## Untyped Notes\n\n";
            foreach ($untypedNotes as $n) {
                $md .= "- [{$n['title']}]({$n['path']})\n";
            }
        }

        // Unlinked count
        $linkedIds = [];
        foreach ($linkList as $l) {
            $linkedIds[$l['source_note_id']] = true;
            $linkedIds[$l['target_note_id']] = true;
        }
        $unlinkedCount = 0;
        foreach ($noteMap as $nid => $_) {
            if (!isset($linkedIds[$nid])) $unlinkedCount++;
        }
        if ($unlinkedCount > 0) {
            $md .= "\n## [Unlinked Notes](unlinked.md) ({$unlinkedCount})\n";
        }

        // Recent notes (last 10)
        $recentIds = array_slice(array_reverse(array_keys($noteMap)), 0, 10);
        if ($recentIds) {
            $md .= "\n## Recent Notes\n\n";
            foreach ($recentIds as $rid) {
                $rpath = $noteMap[$rid] ?? '';
                $rtitle = $noteTitles[$rid] ?? $rid;
                $md .= "- [{$rtitle}]({$rpath})\n";
            }
        }

        return $md;
    }

    /**
     * Page listing notes with no structural links.
     */
    public static function buildUnlinkedPage(array $unlinked): string
    {
        $md = "# Unlinked Notes\n\n";
        $md .= "These notes have no structural links to other notes.\n\n";

        if (empty($unlinked)) {
            $md .= "*All notes are linked.*\n";
            return $md;
        }

        foreach ($unlinked as $n) {
            $md .= "- [{$n['title']}]({$n['path']})\n";
        }

        return $md;
    }

    /**
     * _index.md for a type folder — type info in frontmatter + note listing.
     */
    public static function buildTypeIndex(array $type, array $typeById, array $folderNotes): string
    {
        $fm = [
            'title' => $type['label'],
            'type_id' => $type['id'],
            'type_key' => $type['key'],
        ];
        if (!empty($type['description'])) $fm['description'] = $type['description'];
        if (!empty($type['parent_id']) && isset($typeById[$type['parent_id']])) {
            $fm['parent'] = $typeById[$type['parent_id']]['label'];
        }
        if (!empty($type['created_at'])) $fm['created_at'] = ExportHelpers::isoDate($type['created_at']);

        $body = "# {$type['label']}\n\n";
        if (!empty($type['description'])) {
            $body .= "{$type['description']}\n\n";
        }
        if ($folderNotes) {
            $body .= "## Notes\n\n";
            foreach ($folderNotes as $fn) {
                $relPath = basename($fn['path']);
                $body .= "- [{$fn['title']}]({$relPath})\n";
            }
        }

        return ExportHelpers::renderFrontmatter($fm) . $body;
    }

    /**
     * Root README.md explaining the export structure.
     */
    public static function buildReadme(string $nookName, string $exportedAt, array $stats): string
    {
        return <<<MD
        # {$nookName}

        Exported from [Paith Notes](https://paith.io) on {$exportedAt}.

        ## Contents

        | | Count |
        |---|---|
        | Notes | {$stats['notes']} |
        | Types | {$stats['types']} |
        | Attributes | {$stats['attributes']} |
        | Link predicates | {$stats['predicates']} |
        | Note links | {$stats['links']} |
        | Files | {$stats['files']} |

        ## Structure

        ```
        manifest.json           — Export metadata, schema version, stats
        README.md               — This file
        meta/
          types.json            — Note type definitions (hierarchy, layout)
          attributes.json       — Type attribute definitions
          predicates.json       — Link predicates and rules
          links.json            — Note-to-note links
          files.json            — File attachment metadata
        notes/
          index.md              — Dashboard with stats and note listing
          unlinked.md           — Notes with no links
          map.json              — UUID ↔ file path mapping
          {Type}/               — Folders follow the type hierarchy
            _index.md           — Type info + note listing
            {Note Title}.md     — Notes with YAML frontmatter
        files/
          {note-uuid}/          — File attachments grouped by note
            {attr-name}/
              filename.ext
        ```

        ## Notes format

        Each `.md` file has YAML frontmatter with:
        - `id` — UUID (for reimport)
        - `type` — Note type label
        - `version` — Note version number
        - `created_at` / `updated_at` — Timestamps
        - `created_by` / `updated_by` — Author names
        - `attributes` — Structured data (text, number, date, etc.)
        - `links` — Outgoing note links grouped by predicate
        - `mentions` — Referenced notes

        Attributes are also rendered as markdown sections in the note body,
        split around the content position (some appear above, some below).
        Links in the body use relative paths so they work in any markdown viewer.

        ## Reimport

        The `meta/` JSON files plus `notes/map.json` contain the full lossless
        data needed for reimporting back into Paith Notes. The `.md` rendering
        is the human-readable representation.
        MD;
    }
}
