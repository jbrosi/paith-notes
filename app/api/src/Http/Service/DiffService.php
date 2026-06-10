<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

/**
 * Simple line-based unified diff using longest common subsequence.
 */
final class DiffService
{
    /**
     * Generate a unified diff between two strings.
     *
     * @return array{
     *   diff: string,
     *   hunks: array<array{old_start: int, old_count: int, new_start: int, new_count: int, lines: array<array{type: string, content: string}>}>,
     *   stats: array{additions: int, deletions: int, unchanged: int}
     * }
     */
    public static function unifiedDiff(string $old, string $new, int $contextLines = 3): array
    {
        $oldLines = self::splitLines($old);
        $newLines = self::splitLines($new);

        $ops = self::computeOps($oldLines, $newLines);

        // Build hunks with context
        $hunks = [];
        $currentHunk = null;
        $additions = 0;
        $deletions = 0;
        $unchanged = 0;
        $lastChangeIdx = -999;

        foreach ($ops as $idx => $op) {
            if ($op['type'] !== 'equal') {
                // Start new hunk or extend current
                if ($currentHunk === null || $idx - $lastChangeIdx > $contextLines * 2) {
                    // Finish previous hunk with trailing context
                    if ($currentHunk !== null) {
                        $hunks[] = $currentHunk;
                    }
                    // Start new hunk with leading context
                    $currentHunk = ['old_start' => 0, 'old_count' => 0, 'new_start' => 0, 'new_count' => 0, 'lines' => []];
                    $contextStart = max(0, $idx - $contextLines);
                    for ($c = $contextStart; $c < $idx; $c++) {
                        if ($c < count($ops) && $ops[$c]['type'] === 'equal') {
                            if ($currentHunk['lines'] === []) {
                                $currentHunk['old_start'] = $ops[$c]['old_line'];
                                $currentHunk['new_start'] = $ops[$c]['new_line'];
                            }
                            $currentHunk['lines'][] = ['type' => 'context', 'content' => $ops[$c]['content']];
                            $currentHunk['old_count']++;
                            $currentHunk['new_count']++;
                        }
                    }
                }
                $lastChangeIdx = $idx;

                if ($currentHunk['lines'] === []) {
                    $currentHunk['old_start'] = $op['old_line'];
                    $currentHunk['new_start'] = $op['new_line'];
                }
                $currentHunk['lines'][] = ['type' => $op['type'], 'content' => $op['content']];
                if ($op['type'] === 'delete') {
                    $currentHunk['old_count']++;
                    $deletions++;
                } elseif ($op['type'] === 'insert') {
                    $currentHunk['new_count']++;
                    $additions++;
                }
            } else {
                $unchanged++;
                // Add trailing context to current hunk
                if ($currentHunk !== null && $idx - $lastChangeIdx <= $contextLines) {
                    $currentHunk['lines'][] = ['type' => 'context', 'content' => $op['content']];
                    $currentHunk['old_count']++;
                    $currentHunk['new_count']++;
                }
            }
        }

        if ($currentHunk !== null) {
            $hunks[] = $currentHunk;
        }

        // Build unified diff text
        $diffLines = [];
        foreach ($hunks as $hunk) {
            $diffLines[] = sprintf(
                '@@ -%d,%d +%d,%d @@',
                $hunk['old_start'],
                $hunk['old_count'],
                $hunk['new_start'],
                $hunk['new_count']
            );
            foreach ($hunk['lines'] as $line) {
                $prefix = match ($line['type']) {
                    'insert' => '+',
                    'delete' => '-',
                    default => ' ',
                };
                $diffLines[] = $prefix . $line['content'];
            }
        }

        return [
            'diff' => implode("\n", $diffLines),
            'hunks' => $hunks,
            'stats' => [
                'additions' => $additions,
                'deletions' => $deletions,
                'unchanged' => $unchanged,
            ],
        ];
    }

    /**
     * Compute edit operations using LCS.
     *
     * @param string[] $old
     * @param string[] $new
     * @return array<array{type: string, content: string, old_line: int, new_line: int}>
     */
    private static function computeOps(array $old, array $new): array
    {
        $m = count($old);
        $n = count($new);

        // LCS table
        $lcs = array_fill(0, $m + 1, array_fill(0, $n + 1, 0));
        for ($i = $m - 1; $i >= 0; $i--) {
            for ($j = $n - 1; $j >= 0; $j--) {
                if ($old[$i] === $new[$j]) {
                    $lcs[$i][$j] = $lcs[$i + 1][$j + 1] + 1;
                } else {
                    $lcs[$i][$j] = max($lcs[$i + 1][$j], $lcs[$i][$j + 1]);
                }
            }
        }

        // Walk the LCS table to produce ops
        $ops = [];
        $i = 0;
        $j = 0;
        while ($i < $m || $j < $n) {
            if ($i < $m && $j < $n && $old[$i] === $new[$j]) {
                $ops[] = ['type' => 'equal', 'content' => $old[$i], 'old_line' => $i + 1, 'new_line' => $j + 1];
                $i++;
                $j++;
            } elseif ($j < $n && ($i >= $m || $lcs[$i][$j + 1] >= $lcs[$i + 1][$j])) {
                $ops[] = ['type' => 'insert', 'content' => $new[$j], 'old_line' => $i + 1, 'new_line' => $j + 1];
                $j++;
            } else {
                $ops[] = ['type' => 'delete', 'content' => $old[$i], 'old_line' => $i + 1, 'new_line' => $j + 1];
                $i++;
            }
        }

        return $ops;
    }

    /** @return string[] */
    private static function splitLines(string $text): array
    {
        if ($text === '') {
            return [];
        }
        return explode("\n", $text);
    }
}
