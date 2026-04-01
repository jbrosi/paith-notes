<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Search;

/**
 * Splits a search query into terms, respecting double-quoted phrases,
 * and builds SQL WHERE clauses + bind parameters for LIKE search.
 */
final class SearchQueryParser
{
    /**
     * Split query into terms, respecting "double quoted phrases".
     *
     * @return string[]
     */
    public static function splitTerms(string $query): array
    {
        $terms = [];
        $len = strlen($query);
        $i = 0;

        while ($i < $len) {
            while ($i < $len && ctype_space($query[$i])) {
                $i++;
            }
            if ($i >= $len) {
                break;
            }

            if ($query[$i] === '"') {
                $i++;
                $start = $i;
                while ($i < $len && $query[$i] !== '"') {
                    $i++;
                }
                $phrase = substr($query, $start, $i - $start);
                $trimmed = trim($phrase);
                if ($trimmed !== '') {
                    $terms[] = $trimmed;
                }
                if ($i < $len) {
                    $i++;
                }
            } else {
                $start = $i;
                while ($i < $len && !ctype_space($query[$i]) && $query[$i] !== '"') {
                    $i++;
                }
                $word = substr($query, $start, $i - $start);
                if ($word !== '') {
                    $terms[] = $word;
                }
            }
        }

        return $terms;
    }

    /**
     * Build a SQL WHERE clause, rank expression, and bindings for a multi-word search.
     *
     * @param string $q           Lowercased search query
     * @param string $searchMode  'and' or 'or'
     * @param string $titleCol    SQL expression for the title column (e.g. 'lower(n.title)')
     * @param string $contentCol  SQL expression for the content column (e.g. 'lower(n.content)')
     * @param string $prefix      Prefix for WHERE clause (e.g. 'and' or empty)
     * @return array{where: string, rank: string, bindings: array<string, string>}
     */
    public static function buildSearchClause(
        string $q,
        string $searchMode = 'and',
        string $titleCol = 'lower(n.title)',
        string $contentCol = 'lower(n.content)',
        string $prefix = 'and',
    ): array {
        $result = ['where' => '', 'rank' => '0', 'bindings' => []];

        if ($q === '') {
            return $result;
        }

        $words = self::splitTerms($q);
        if ($words === []) {
            return $result;
        }

        $clauses = [];
        $rankParts = [];
        $bindings = [];

        foreach ($words as $i => $word) {
            $qp = ':q' . $i;
            $rp = ':r' . $i;
            $clauses[] = "({$titleCol} like {$qp} or {$contentCol} like {$qp})";
            $bindings[$qp] = '%' . $word . '%';
            $rankParts[] = "(similarity({$titleCol}, {$rp}) * 3 + similarity({$contentCol}, {$rp}))";
            $bindings[$rp] = $word;
        }

        $glue = $searchMode === 'or' ? ' or ' : ' and ';
        $whereInner = implode($glue, $clauses);
        $result['where'] = $prefix !== '' ? "{$prefix} ({$whereInner})" : "({$whereInner})";
        $result['rank'] = '(' . implode(' + ', $rankParts) . ')';
        $result['bindings'] = $bindings;

        return $result;
    }
}
