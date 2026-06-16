<?php

declare(strict_types=1);

use Paith\Notes\Shared\Search\SearchQueryParser;

/**
 * Pure-function coverage for the query parser. No database, no HTTP.
 * Pins down tokenization (whitespace + quoted phrases) and the
 * shape of the WHERE/rank/bindings tuple buildSearchClause returns.
 */

it('splits a plain space-separated query into individual terms', function (): void {
    expect(SearchQueryParser::splitTerms('foo bar baz'))->toBe(['foo', 'bar', 'baz']);
});

it('collapses runs of whitespace and ignores leading/trailing space', function (): void {
    expect(SearchQueryParser::splitTerms("  foo\tbar  \n baz "))->toBe(['foo', 'bar', 'baz']);
});

it('treats a double-quoted run as a single phrase term', function (): void {
    expect(SearchQueryParser::splitTerms('foo "bar baz" qux'))->toBe(['foo', 'bar baz', 'qux']);
});

it('handles an unterminated quote by consuming until end of string', function (): void {
    expect(SearchQueryParser::splitTerms('"unterminated phrase'))->toBe(['unterminated phrase']);
});

it('drops empty phrases ("") rather than emitting blank terms', function (): void {
    expect(SearchQueryParser::splitTerms('foo "" bar'))->toBe(['foo', 'bar']);
});

it('returns an empty list for empty or whitespace-only input', function (): void {
    expect(SearchQueryParser::splitTerms(''))->toBe([]);
    expect(SearchQueryParser::splitTerms('   '))->toBe([]);
});

it('returns an empty clause tuple when the query is empty', function (): void {
    $r = SearchQueryParser::buildSearchClause('');
    expect($r['where'])->toBe('');
    expect($r['rank'])->toBe('0');
    expect($r['bindings'])->toBe([]);
});

it('joins multiple terms with AND by default', function (): void {
    $r = SearchQueryParser::buildSearchClause('foo bar', 'and', 'lower(n.title)', 'lower(n.content)', 'and');
    // Two clauses, glued with " and "
    expect(substr_count($r['where'], ' and '))->toBeGreaterThanOrEqual(1);
    expect($r['where'])->toContain('lower(n.title) like :q0');
    expect($r['where'])->toContain('lower(n.title) like :q1');
    expect($r['bindings'])->toMatchArray([
        ':q0' => '%foo%',
        ':q1' => '%bar%',
        ':r0' => 'foo',
        ':r1' => 'bar',
    ]);
});

it('joins multiple terms with OR when search_mode=or', function (): void {
    $r = SearchQueryParser::buildSearchClause('foo bar', 'or');
    // Outer prefix defaults to 'and' but the inner glue must be ' or '
    $whereInner = $r['where'];
    expect($whereInner)->toContain(' or ');
    expect($whereInner)->not->toContain(' and (');
});

it('omits the prefix entirely when called with an empty prefix', function (): void {
    $r = SearchQueryParser::buildSearchClause('foo', 'and', 'lower(n.title)', 'lower(n.content)', '');
    // Should not start with the prefix keyword
    expect(str_starts_with($r['where'], 'and '))->toBeFalse();
    expect(str_starts_with($r['where'], '('))->toBeTrue();
});

it('uses the supplied column expressions verbatim', function (): void {
    $r = SearchQueryParser::buildSearchClause('foo', 'and', 'h.text', 'h.body');
    expect($r['where'])->toContain('h.text like :q0');
    expect($r['where'])->toContain('h.body like :q0');
    expect($r['rank'])->toContain('similarity(h.text, :r0)');
});

it('builds a sum-of-similarities rank expression with one summand per term', function (): void {
    $r = SearchQueryParser::buildSearchClause('foo bar baz');
    // One similarity(title, ...) call per term — three terms, three calls.
    expect(substr_count($r['rank'], 'similarity(lower(n.title)'))->toBe(3);
    expect(substr_count($r['rank'], 'similarity(lower(n.content)'))->toBe(3);
});
