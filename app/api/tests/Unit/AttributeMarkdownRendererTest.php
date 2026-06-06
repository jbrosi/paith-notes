<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Controller\Export\AttributeMarkdownRenderer;

it('renders text', function (): void {
    expect(AttributeMarkdownRenderer::render('text', 'hello'))->toBe('hello');
    expect(AttributeMarkdownRenderer::render('text', ''))->toBeNull();
    expect(AttributeMarkdownRenderer::render('text', null))->toBeNull();
});

it('renders numbers', function (): void {
    expect(AttributeMarkdownRenderer::render('number', 42))->toBe('42');
    expect(AttributeMarkdownRenderer::render('number', 3.14))->toBe('3.14');
    expect(AttributeMarkdownRenderer::render('number', null))->toBeNull();
});

it('renders numbers as star ratings', function (): void {
    $config = ['display' => 'rating', 'max' => 5];
    expect(AttributeMarkdownRenderer::render('number', 3, $config))->toBe('★★★☆☆');
    expect(AttributeMarkdownRenderer::render('number', 5, $config))->toBe('★★★★★');
    expect(AttributeMarkdownRenderer::render('number', 0, $config))->toBe('☆☆☆☆☆');
});

it('renders booleans', function (): void {
    expect(AttributeMarkdownRenderer::render('boolean', true))->toBe('- [x] Yes');
    expect(AttributeMarkdownRenderer::render('boolean', false))->toBe('- [ ] No');
});

it('renders dates', function (): void {
    expect(AttributeMarkdownRenderer::render('date', '2026-06-06'))->toBe('2026-06-06');
    expect(AttributeMarkdownRenderer::render('date', ''))->toBeNull();
});

it('renders date ranges', function (): void {
    expect(AttributeMarkdownRenderer::render('date_range', ['from' => '2026-01-01', 'to' => '2026-12-31']))
        ->toBe('2026-01-01 → 2026-12-31');
    expect(AttributeMarkdownRenderer::render('date_range', ['from' => '2026-01-01', 'to' => '']))
        ->toBe('from 2026-01-01');
    expect(AttributeMarkdownRenderer::render('date_range', ['from' => '', 'to' => '2026-12-31']))
        ->toBe('until 2026-12-31');
});

it('renders select as backtick-wrapped', function (): void {
    expect(AttributeMarkdownRenderer::render('select', 'draft'))->toBe('`draft`');
});

it('renders multi_select as space-separated badges', function (): void {
    expect(AttributeMarkdownRenderer::render('multi_select', ['fiction', 'sci-fi']))
        ->toBe('`fiction` `sci-fi`');
    expect(AttributeMarkdownRenderer::render('multi_select', []))->toBeNull();
});

it('renders URLs with domain as link text', function (): void {
    expect(AttributeMarkdownRenderer::render('url', 'https://example.com/path'))
        ->toBe('[example.com](https://example.com/path)');
});

it('skips presentational kinds', function (): void {
    expect(AttributeMarkdownRenderer::render('history', null))->toBeNull();
    expect(AttributeMarkdownRenderer::render('toc', null))->toBeNull();
    expect(AttributeMarkdownRenderer::render('metadata', null))->toBeNull();
    expect(AttributeMarkdownRenderer::render('content', null))->toBeNull();
    expect(AttributeMarkdownRenderer::render('source', null))->toBeNull();
});

it('splits rendering around content attribute', function (): void {
    $attrDefs = [
        ['id' => 'a1', 'name' => 'Status', 'kind' => 'select', 'config' => []],
        ['id' => 'a2', 'name' => 'Body', 'kind' => 'content', 'config' => []],
        ['id' => 'a3', 'name' => 'Rating', 'kind' => 'number', 'config' => ['display' => 'rating', 'max' => 5]],
    ];
    $rawAttrs = ['a1' => 'draft', 'a3' => 4];

    $split = AttributeMarkdownRenderer::renderSplit($rawAttrs, $attrDefs, []);

    expect($split['before'])->toContain('Status');
    expect($split['before'])->toContain('`draft`');
    expect($split['after'])->toContain('Rating');
    expect($split['after'])->toContain('★★★★☆');
    // Content itself is not rendered
    expect($split['before'])->not->toContain('Body');
    expect($split['after'])->not->toContain('Body');
});

it('renders linked_notes with relative paths', function (): void {
    $ctx = [
        'note_id' => 'note-1',
        'noteMap' => ['note-2' => 'Note/Other.md'],
        'noteTitles' => ['note-2' => 'Other Note'],
        'noteDir' => 'Note/Meeting',
        'linksBySource' => [
            'note-1' => [
                ['predicate' => 'relates to', 'target_id' => 'note-2'],
            ],
        ],
    ];

    $result = AttributeMarkdownRenderer::render('linked_notes', null, [], $ctx);
    expect($result)->toContain('[Other Note](../Other.md)');
    expect($result)->toContain('**relates to**');
});

it('renders mentions with relative paths', function (): void {
    $ctx = [
        'note_id' => 'note-1',
        'noteMap' => ['note-3' => 'Person/Jane.md'],
        'noteTitles' => ['note-3' => 'Jane Doe'],
        'noteDir' => 'Note',
        'mentionsBySource' => ['note-1' => ['note-3']],
    ];

    $result = AttributeMarkdownRenderer::render('mentions', null, [], $ctx);
    expect($result)->toContain('[Jane Doe](../Person/Jane.md)');
});

it('renders graph as mermaid', function (): void {
    $ctx = [
        'note_id' => 'note-1',
        'noteTitles' => ['note-1' => 'Root', 'note-2' => 'Child'],
        'linksBySource' => [
            'note-1' => [
                ['predicate' => 'has', 'target_id' => 'note-2'],
            ],
        ],
    ];

    $result = AttributeMarkdownRenderer::render('graph', ['rootNoteId' => 'note-1'], [], $ctx);
    expect($result)->toContain('```mermaid');
    expect($result)->toContain('graph LR');
    expect($result)->toContain('-->|has|');
    expect($result)->toContain('```', 2);
});
