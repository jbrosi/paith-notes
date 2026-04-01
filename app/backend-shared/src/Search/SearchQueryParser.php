<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Search;

/**
 * Splits a search query into terms, respecting double-quoted phrases.
 *
 * Examples:
 *   'foo bar'           → ['foo', 'bar']
 *   '"foo bar" baz'     → ['foo bar', 'baz']
 *   '"meeting notes"'   → ['meeting notes']
 *   'hello "world" test' → ['hello', 'world', 'test']
 *
 * @return string[]
 */
final class SearchQueryParser
{
    /**
     * @return string[]
     */
    public static function splitTerms(string $query): array
    {
        $terms = [];
        $len = strlen($query);
        $i = 0;

        while ($i < $len) {
            // Skip whitespace
            while ($i < $len && ctype_space($query[$i])) {
                $i++;
            }
            if ($i >= $len) {
                break;
            }

            if ($query[$i] === '"') {
                // Quoted phrase — find closing quote
                $i++; // skip opening quote
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
                    $i++; // skip closing quote
                }
            } else {
                // Unquoted word — read until whitespace or quote
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
}
