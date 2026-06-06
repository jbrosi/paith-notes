<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

use Paith\Notes\Shared\Db\Row;

/**
 * Renders note attributes to markdown for export.
 *
 * Each attribute kind has a render function that produces human-readable
 * markdown. Presentational-only kinds (toc, history, metadata, content, source)
 * are skipped — they have no user data to render.
 *
 * @phpstan-import-type RenderContext from ExportTypes
 * @phpstan-import-type AttrRow from ExportTypes
 * @phpstan-import-type FileRow from ExportTypes
 * @phpstan-import-type NoteLinkSummary from ExportTypes
 */
final class AttributeMarkdownRenderer
{
    /**
     * Render a single attribute value to markdown.
     *
     * Context-driven kinds (file, linked_notes, mentions, graph) require a
     * populated RenderContext. When the context is empty (e.g. callers that
     * only render scalar data kinds), those kinds short-circuit to null.
     *
     * @param array<string, mixed>  $config   Attribute config
     * @param RenderContext|array{} $context  Per-note render context, or [] for scalar-only callers
     */
    public static function render(string $kind, mixed $value, array $config = [], array $context = []): ?string
    {
        return match ($kind) {
            // Data kinds — require a value
            'text' => $value !== null ? self::renderText($value) : null,
            'number' => $value !== null ? self::renderNumber($value, $config) : null,
            'boolean' => $value !== null ? self::renderBoolean($value) : null,
            'date' => $value !== null ? self::renderDate($value) : null,
            'date_range' => $value !== null ? self::renderDateRange($value) : null,
            'select' => $value !== null ? self::renderSelect($value) : null,
            'multi_select' => $value !== null ? self::renderMultiSelect($value) : null,
            'url' => $value !== null ? self::renderUrl($value) : null,
            // Context-driven kinds — only when context is populated
            'file' => $context === [] ? null : self::renderFile($context),
            'linked_notes' => $context === [] ? null : self::renderLinkedNotes($context),
            'mentions' => $context === [] ? null : self::renderMentions($context),
            'graph' => $context === [] ? null : self::renderGraph($value, $context),
            // Presentational — no user data to export
            'history', 'toc', 'metadata', 'content', 'source' => null,
            default => null,
        };
    }

    /**
     * Render attributes split around the content attribute.
     *
     * Returns { before: md, after: md } — content goes between them.
     * If no content attribute exists, everything goes in "after".
     *
     * @param array<string, mixed> $rawAttrs  Note attributes { attr_id → value }
     * @param list<AttrRow>        $attrDefs  Attribute definitions in layout order
     * @param RenderContext        $context   Shared context for rendering
     * @return array{before: string, after: string}
     */
    public static function renderSplit(array $rawAttrs, array $attrDefs, array $context): array
    {
        $before = [];
        $after = [];
        $seenContent = false;

        foreach ($attrDefs as $def) {
            $kind = $def['kind'];

            if ($kind === 'content') {
                $seenContent = true;
                continue;
            }

            $attrId = $def['id'];
            $name = $def['name'];
            $config = Row::decodeJsonObject($def['config']);

            $value = $rawAttrs[$attrId] ?? null;
            $rendered = self::render($kind, $value, $config, $context);
            if ($rendered === null || $rendered === '') {
                continue;
            }

            $section = "### {$name}\n\n{$rendered}";
            if ($seenContent) {
                $after[] = $section;
            } else {
                $before[] = $section;
            }
        }

        $beforeMd = '';
        if ($before !== []) {
            $beforeMd = implode("\n\n", $before) . "\n\n";
        }

        $afterMd = '';
        if ($after !== []) {
            $afterMd = "\n\n---\n\n" . implode("\n\n", $after);
        }

        return ['before' => $beforeMd, 'after' => $afterMd];
    }

    // ── Kind renderers ──────────────────────────────────────────

    private static function renderText(mixed $value): ?string
    {
        $s = is_scalar($value) ? (string)$value : '';
        return $s !== '' ? $s : null;
    }

    /**
     * @param array<string, mixed> $config
     */
    private static function renderNumber(mixed $value, array $config): ?string
    {
        if (!is_numeric($value)) {
            return null;
        }
        $num = (float) $value;

        // Rating display: render as stars
        $display = $config['display'] ?? null;
        if ($display === 'rating' || $display === 'stars') {
            $maxRaw = $config['max'] ?? 5;
            $max = is_numeric($maxRaw) ? (int)$maxRaw : 5;
            $filled = (int) round($num);
            $filled = max(0, min($filled, $max));
            return str_repeat('★', $filled) . str_repeat('☆', $max - $filled);
        }

        // Suffix/prefix
        $suffix = is_scalar($config['suffix'] ?? null) ? (string)$config['suffix'] : '';
        $prefix = is_scalar($config['prefix'] ?? null) ? (string)$config['prefix'] : '';
        $formatted = floor($num) !== $num
            ? rtrim(rtrim(number_format($num, 2), '0'), '.')
            : (string) (int) $num;

        return "{$prefix}{$formatted}{$suffix}";
    }

    private static function renderBoolean(mixed $value): string
    {
        return $value ? '- [x] Yes' : '- [ ] No';
    }

    private static function renderDate(mixed $value): ?string
    {
        $s = is_scalar($value) ? (string)$value : '';
        return $s !== '' ? $s : null;
    }

    private static function renderDateRange(mixed $value): ?string
    {
        if (!is_array($value)) {
            return null;
        }
        $from = is_scalar($value['from'] ?? null) ? (string)$value['from'] : '';
        $to = is_scalar($value['to'] ?? null) ? (string)$value['to'] : '';
        if ($from === '' && $to === '') {
            return null;
        }
        if ($from !== '' && $to !== '') {
            return "{$from} → {$to}";
        }
        if ($from !== '') {
            return "from {$from}";
        }
        return "until {$to}";
    }

    private static function renderSelect(mixed $value): ?string
    {
        $s = is_scalar($value) ? (string)$value : '';
        return $s !== '' ? "`{$s}`" : null;
    }

    private static function renderMultiSelect(mixed $value): ?string
    {
        if (!is_array($value) || $value === []) {
            return null;
        }
        $parts = [];
        foreach ($value as $v) {
            if (is_scalar($v)) {
                $parts[] = '`' . (string)$v . '`';
            }
        }
        return $parts === [] ? null : implode(' ', $parts);
    }

    private static function renderUrl(mixed $value): ?string
    {
        $url = is_scalar($value) ? (string)$value : '';
        if ($url === '') {
            return null;
        }
        // Show domain as link text
        $host = parse_url($url, PHP_URL_HOST) ?: $url;
        return "[{$host}]({$url})";
    }

    /**
     * @param RenderContext $context
     */
    private static function renderFile(array $context): ?string
    {
        $noteId = $context['note_id'];
        $noteTitles = $context['noteTitles'];
        $noteFiles = $context['noteFiles'];
        $noteDir = $context['noteDir'];
        $attrById = $context['attrById'];

        $files = $noteFiles[$noteId] ?? [];
        if ($files === []) {
            return null;
        }

        $noteTitle = $noteTitles[$noteId] ?? 'Untitled';
        $lines = [];
        foreach ($files as $f) {
            $fullFilename = ExportHelpers::buildFilename($f['filename'], $f['extension']);

            $attrName = null;
            if ($f['attribute_id'] !== null && isset($attrById[$f['attribute_id']])) {
                $attrName = ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name']);
            }
            $fileZipPath = ExportHelpers::buildFileZipPath($noteTitle, $attrName, $fullFilename);

            $rel = ExportHelpers::relativePath("notes/{$noteDir}", $fileZipPath);
            $isImage = str_starts_with($f['mime_type'], 'image/');

            if ($isImage) {
                $lines[] = "![{$fullFilename}]({$rel})";
            } else {
                $size = ExportHelpers::humanFilesize($f['filesize']);
                $lines[] = "[{$fullFilename}]({$rel}) ({$size})";
            }
        }

        return implode("\n\n", $lines);
    }

    /**
     * @param RenderContext $context
     */
    private static function renderLinkedNotes(array $context): ?string
    {
        $noteId = $context['note_id'];
        $linksBySource = $context['linksBySource'];
        $noteTitles = $context['noteTitles'];
        $noteMap = $context['noteMap'];
        $noteDir = $context['noteDir'];

        $links = $linksBySource[$noteId] ?? [];
        if ($links === []) {
            return null;
        }

        $lines = [];
        foreach ($links as $link) {
            $targetId = $link['target_id'];
            $title = $noteTitles[$targetId] ?? $targetId;
            $predicate = $link['predicate'];
            $targetPath = $noteMap[$targetId] ?? null;
            if ($targetPath !== null && $targetPath !== '') {
                $rel = ExportHelpers::relativePath($noteDir, $targetPath);
                $lines[] = "- **{$predicate}**: [{$title}]({$rel})";
            } else {
                $lines[] = "- **{$predicate}**: {$title}";
            }
        }

        return implode("\n", $lines);
    }

    /**
     * @param RenderContext $context
     */
    private static function renderMentions(array $context): ?string
    {
        $noteId = $context['note_id'];
        $mentionsBySource = $context['mentionsBySource'];
        $noteTitles = $context['noteTitles'];
        $noteMap = $context['noteMap'];
        $noteDir = $context['noteDir'];

        $mentions = $mentionsBySource[$noteId] ?? [];
        if ($mentions === []) {
            return null;
        }

        $lines = [];
        foreach ($mentions as $mid) {
            $title = $noteTitles[$mid] ?? $mid;
            $targetPath = $noteMap[$mid] ?? null;
            if ($targetPath !== null && $targetPath !== '') {
                $rel = ExportHelpers::relativePath($noteDir, $targetPath);
                $lines[] = "- [{$title}]({$rel})";
            } else {
                $lines[] = "- {$title}";
            }
        }

        return implode("\n", $lines);
    }

    /**
     * @param RenderContext $context
     */
    private static function renderGraph(mixed $value, array $context): ?string
    {
        if (!is_array($value)) {
            return null;
        }

        $noteId = $context['note_id'];
        $linksBySource = $context['linksBySource'];
        $noteTitles = $context['noteTitles'];

        // Build a simple mermaid graph from the note's links
        $links = $linksBySource[$noteId] ?? [];
        if ($links === []) {
            return null;
        }

        $rootTitle = $noteTitles[$noteId] ?? 'root';
        $lines = ["```mermaid", "graph LR"];
        $safeRoot = self::mermaidId($noteId, $rootTitle);
        $seen = [];

        foreach ($links as $link) {
            $targetId = $link['target_id'];
            $targetTitle = $noteTitles[$targetId] ?? $targetId;
            $predicate = $link['predicate'];
            $safeTarget = self::mermaidId($targetId, $targetTitle);

            $key = "{$noteId}-{$targetId}";
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;

            $lines[] = "    {$safeRoot} -->|{$predicate}| {$safeTarget}";
        }

        $lines[] = "```";
        return implode("\n", $lines);
    }

    // ── Shared helpers ──────────────────────────────────────────

    private static function mermaidId(string $id, string $title): string
    {
        $short = substr($id, 0, 8);
        $safe = preg_replace('/[^a-zA-Z0-9 ]/', '', $title) ?? $title;
        return "{$short}[\"{$safe}\"]";
    }
}
