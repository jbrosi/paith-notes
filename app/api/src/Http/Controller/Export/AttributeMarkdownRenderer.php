<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * Renders note attributes to markdown for export.
 *
 * Each attribute kind has a render function that produces human-readable
 * markdown. Presentational-only kinds (toc, history, metadata, content, source)
 * are skipped — they have no user data to render.
 */
final class AttributeMarkdownRenderer
{
    /**
     * Render a single attribute value to markdown.
     *
     * @param string               $kind       Attribute kind
     * @param mixed                $value      The stored attribute value
     * @param array<string, mixed> $config     Attribute config (options, display, etc.)
     * @param array<string, mixed> $context    Extra context: noteMap, noteTitles, noteFiles, noteDir, attrById
     * @return string|null  Rendered markdown, or null to skip
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
            // Context-driven kinds — value is optional, data comes from context
            'file' => self::renderFile($value, $context),
            'linked_notes' => self::renderLinkedNotes($context),
            'mentions' => self::renderMentions($context),
            'graph' => self::renderGraph($value, $context),
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
     * @param array<string, mixed>       $rawAttrs   Note attributes { attr_id → value }
     * @param list<array<string, mixed>> $attrDefs   Attribute definitions in layout order
     * @param array<string, mixed>       $context    Shared context for rendering
     * @return array{before: string, after: string}
     */
    public static function renderSplit(array $rawAttrs, array $attrDefs, array $context): array
    {
        $before = [];
        $after = [];
        $seenContent = false;

        foreach ($attrDefs as $def) {
            $kind = $def['kind'] ?? '';

            if ($kind === 'content') {
                $seenContent = true;
                continue;
            }

            $attrId = $def['id'] ?? '';
            $name = $def['name'] ?? '';
            $config = is_string($def['config'] ?? null) ? json_decode($def['config'], true) : ($def['config'] ?? []);
            if (!is_array($config)) {
                $config = [];
            }

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
        if ($before) {
            $beforeMd = implode("\n\n", $before) . "\n\n";
        }

        $afterMd = '';
        if ($after) {
            $afterMd = "\n\n---\n\n" . implode("\n\n", $after);
        }

        return ['before' => $beforeMd, 'after' => $afterMd];
    }

    // ── Kind renderers ──────────────────────────────────────────

    private static function renderText(mixed $value): ?string
    {
        $s = (string) $value;
        return $s !== '' ? $s : null;
    }

    private static function renderNumber(mixed $value, array $config): ?string
    {
        if (!is_numeric($value)) {
            return null;
        }
        $num = (float) $value;

        // Rating display: render as stars
        $display = $config['display'] ?? null;
        if ($display === 'rating' || $display === 'stars') {
            $max = (int) ($config['max'] ?? 5);
            $filled = (int) round($num);
            $filled = max(0, min($filled, $max));
            return str_repeat('★', $filled) . str_repeat('☆', $max - $filled);
        }

        // Suffix/prefix
        $suffix = $config['suffix'] ?? '';
        $prefix = $config['prefix'] ?? '';
        $formatted = is_float($num) && floor($num) !== $num
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
        $s = (string) $value;
        return $s !== '' ? $s : null;
    }

    private static function renderDateRange(mixed $value): ?string
    {
        if (!is_array($value)) {
            return null;
        }
        $from = (string) ($value['from'] ?? '');
        $to = (string) ($value['to'] ?? '');
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
        $s = (string) $value;
        return $s !== '' ? "`{$s}`" : null;
    }

    private static function renderMultiSelect(mixed $value): ?string
    {
        if (!is_array($value) || empty($value)) {
            return null;
        }
        return implode(' ', array_map(fn($v) => "`{$v}`", $value));
    }

    private static function renderUrl(mixed $value): ?string
    {
        $url = (string) $value;
        if ($url === '') {
            return null;
        }
        // Show domain as link text
        $host = parse_url($url, PHP_URL_HOST) ?: $url;
        return "[{$host}]({$url})";
    }

    private static function renderFile(mixed $value, array $context): ?string
    {
        $noteId = $context['note_id'] ?? '';
        $noteTitles = $context['noteTitles'] ?? [];
        $noteFiles = $context['noteFiles'] ?? [];
        $noteDir = $context['noteDir'] ?? '';
        $attrById = $context['attrById'] ?? [];

        $files = $noteFiles[$noteId] ?? [];
        if (empty($files)) {
            return null;
        }

        $noteTitle = $noteTitles[$noteId] ?? 'Untitled';
        $lines = [];
        foreach ($files as $f) {
            $filename = (string) ($f['filename'] ?? 'file');
            $ext = (string) ($f['extension'] ?? '');
            $fullFilename = ExportHelpers::buildFilename($filename, $ext);
            $mime = (string) ($f['mime_type'] ?? '');

            $attrName = null;
            if (isset($f['attribute_id'], $attrById[$f['attribute_id']])) {
                $attrName = self::safeFilename($attrById[$f['attribute_id']]['name']);
            }
            $fileZipPath = ExportHelpers::buildFileZipPath($noteTitle, $attrName, $fullFilename);

            $rel = self::relativePath("notes/{$noteDir}", $fileZipPath);
            $isImage = str_starts_with($mime, 'image/');

            if ($isImage) {
                $lines[] = "![{$fullFilename}]({$rel})";
            } else {
                $size = self::humanFilesize((int) ($f['filesize'] ?? 0));
                $lines[] = "[{$fullFilename}]({$rel}) ({$size})";
            }
        }

        return implode("\n\n", $lines);
    }

    private static function renderLinkedNotes(array $context): ?string
    {
        $noteId = $context['note_id'] ?? '';
        $linksBySource = $context['linksBySource'] ?? [];
        $noteTitles = $context['noteTitles'] ?? [];
        $noteMap = $context['noteMap'] ?? [];
        $noteDir = $context['noteDir'] ?? '';

        $links = $linksBySource[$noteId] ?? [];
        if (empty($links)) {
            return null;
        }

        $lines = [];
        foreach ($links as $link) {
            $targetId = $link['target_id'];
            $title = $noteTitles[$targetId] ?? $targetId;
            $predicate = $link['predicate'];
            $targetPath = $noteMap[$targetId] ?? null;
            if ($targetPath) {
                $rel = self::relativePath($noteDir, $targetPath);
                $lines[] = "- **{$predicate}**: [{$title}]({$rel})";
            } else {
                $lines[] = "- **{$predicate}**: {$title}";
            }
        }

        return implode("\n", $lines);
    }

    private static function renderMentions(array $context): ?string
    {
        $noteId = $context['note_id'] ?? '';
        $mentionsBySource = $context['mentionsBySource'] ?? [];
        $noteTitles = $context['noteTitles'] ?? [];
        $noteMap = $context['noteMap'] ?? [];
        $noteDir = $context['noteDir'] ?? '';

        $mentions = $mentionsBySource[$noteId] ?? [];
        if (empty($mentions)) {
            return null;
        }

        $lines = [];
        foreach ($mentions as $mid) {
            $title = $noteTitles[$mid] ?? $mid;
            $targetPath = $noteMap[$mid] ?? null;
            if ($targetPath) {
                $rel = self::relativePath($noteDir, $targetPath);
                $lines[] = "- [{$title}]({$rel})";
            } else {
                $lines[] = "- {$title}";
            }
        }

        return implode("\n", $lines);
    }

    private static function renderGraph(mixed $value, array $context): ?string
    {
        if (!is_array($value)) {
            return null;
        }

        $noteId = $context['note_id'] ?? '';
        $linksBySource = $context['linksBySource'] ?? [];
        $noteTitles = $context['noteTitles'] ?? [];

        // Build a simple mermaid graph from the note's links
        $links = $linksBySource[$noteId] ?? [];
        if (empty($links)) {
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
        $safe = preg_replace('/[^a-zA-Z0-9 ]/', '', $title);
        return "{$short}[\"{$safe}\"]";
    }

    private static function safeFilename(string $name): string
    {
        return ExportHelpers::safeFilename($name);
    }

    private static function relativePath(string $fromDir, string $toPath): string
    {
        return ExportHelpers::relativePath($fromDir, $toPath);
    }

    private static function humanFilesize(int $bytes): string
    {
        return ExportHelpers::humanFilesize($bytes);
    }
}
