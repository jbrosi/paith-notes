<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

use PDO;

final class HeadingsService
{
    private const MAX_HEADINGS = 100;

    /**
     * Extract headings from markdown content and sync to note_headings table.
     * Uses delete + reinsert (same pattern as MentionsService).
     */
    public function syncHeadings(PDO $pdo, string $nookId, string $noteId, string $markdown): void
    {
        $pdo->prepare('delete from global.note_headings where note_id = :note_id and nook_id = :nook_id')
            ->execute([':note_id' => $noteId, ':nook_id' => $nookId]);

        $headings = self::extractHeadings($markdown);
        if ($headings === []) {
            return;
        }

        // Cap to prevent abuse from auto-generated content
        if (count($headings) > self::MAX_HEADINGS) {
            $headings = array_slice($headings, 0, self::MAX_HEADINGS);
        }

        $stmt = $pdo->prepare(
            'insert into global.note_headings (nook_id, note_id, level, text, position) '
            . 'values (:nook_id, :note_id, :level, :text, :position)'
        );

        foreach ($headings as $h) {
            $stmt->execute([
                ':nook_id' => $nookId,
                ':note_id' => $noteId,
                ':level' => $h['level'],
                ':text' => $h['text'],
                ':position' => $h['position'],
            ]);
        }
    }

    /**
     * Extract markdown headings (ATX-style: # through ######).
     *
     * @return array<array{level: int, text: string, position: int}>
     */
    public static function extractHeadings(string $markdown): array
    {
        $headings = [];
        $offset = 0;
        $lines = explode("\n", $markdown);

        $inCodeBlock = false;
        foreach ($lines as $line) {
            $lineStart = $offset;
            $offset += strlen($line) + 1; // +1 for the \n

            $trimmed = ltrim($line);

            // Track fenced code blocks (``` or ~~~) — skip headings inside them
            if (str_starts_with($trimmed, '```') || str_starts_with($trimmed, '~~~')) {
                $inCodeBlock = !$inCodeBlock;
                continue;
            }
            if ($inCodeBlock) {
                continue;
            }

            // Match ATX headings: 1-6 # chars, followed by space, then text
            if (preg_match('/^(#{1,6})\s+(.+)$/', $trimmed, $m)) {
                $level = strlen($m[1]);
                $text = trim($m[2]);
                // Strip trailing # characters (optional closing ATX syntax)
                $text = rtrim($text, '# ');
                $text = trim($text);
                if ($text !== '') {
                    $headings[] = [
                        'level' => $level,
                        'text' => $text,
                        'position' => $lineStart,
                    ];
                }
            }
        }

        return $headings;
    }
}
