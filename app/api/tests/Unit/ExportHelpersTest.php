<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Controller\Export\ExportHelpers;

it('encodes JSON prettily with unicode and slashes', function (): void {
    $result = ExportHelpers::jsonEncode(['path' => '/a/b', 'emoji' => '🎉']);
    expect($result)->toContain('/a/b');
    expect($result)->toContain('🎉');
    expect($result)->not->toContain('\\u');
    expect($result)->not->toContain('\\/');
});

it('formats human filesizes', function (): void {
    expect(ExportHelpers::humanFilesize(0))->toBe('0 B');
    expect(ExportHelpers::humanFilesize(512))->toBe('512 B');
    expect(ExportHelpers::humanFilesize(1024))->toBe('1 KB');
    expect(ExportHelpers::humanFilesize(1536))->toBe('1.5 KB');
    expect(ExportHelpers::humanFilesize(1048576))->toBe('1 MB');
    expect(ExportHelpers::humanFilesize(1073741824))->toBe('1 GB');
});

it('creates safe filenames', function (): void {
    expect(ExportHelpers::safeFilename('Hello World'))->toBe('Hello World');
    expect(ExportHelpers::safeFilename('a/b\\c:d'))->toBe('a-b-c-d');
    expect(ExportHelpers::safeFilename('...'))->toBe('Untitled');
    expect(ExportHelpers::safeFilename(''))->toBe('Untitled');
    expect(ExportHelpers::safeFilename('file<name>test'))->toBe('file-name-test');
});

it('computes relative paths', function (): void {
    // Same directory
    expect(ExportHelpers::relativePath('', 'foo.md'))->toBe('foo.md');
    expect(ExportHelpers::relativePath('.', 'foo.md'))->toBe('foo.md');

    // Sibling
    expect(ExportHelpers::relativePath('Note', 'Note/Other.md'))->toBe('Other.md');

    // Up and across
    expect(ExportHelpers::relativePath('Note/Meeting', 'Person/Employee/Jane.md'))
        ->toBe('../../Person/Employee/Jane.md');

    // Up one
    expect(ExportHelpers::relativePath('Note/Meeting', 'Note/File/image.md'))
        ->toBe('../File/image.md');
});

it('builds type folder hierarchy', function (): void {
    $types = [
        'type-1' => ['id' => 'type-1', 'label' => 'Note', 'parent_id' => null],
        'type-2' => ['id' => 'type-2', 'label' => 'Meeting', 'parent_id' => 'type-1'],
        'type-3' => ['id' => 'type-3', 'label' => 'Standup', 'parent_id' => 'type-2'],
    ];
    $folders = ExportHelpers::buildTypeFolders($types);

    expect($folders['type-1'])->toBe('Note');
    expect($folders['type-2'])->toBe('Note/Meeting');
    expect($folders['type-3'])->toBe('Note/Meeting/Standup');
});

it('renders YAML frontmatter', function (): void {
    $fm = ExportHelpers::renderFrontmatter([
        'id' => 'abc-123',
        'title' => 'Hello World',
        'draft' => false,
        'tags' => ['a', 'b'],
    ]);

    expect($fm)->toStartWith("---\n");
    expect($fm)->toEndWith("---\n\n");
    expect($fm)->toContain("id: abc-123\n");
    expect($fm)->toContain("title: Hello World\n");
    expect($fm)->toContain("draft: false\n");
    expect($fm)->toContain("- a\n");
    expect($fm)->toContain("- b\n");
});

it('quotes special YAML values', function (): void {
    expect(ExportHelpers::yamlScalar('true'))->toBe('"true"');
    expect(ExportHelpers::yamlScalar('null'))->toBe('"null"');
    expect(ExportHelpers::yamlScalar('123'))->toBe('"123"');
    expect(ExportHelpers::yamlScalar('hello'))->toBe('hello');
    expect(ExportHelpers::yamlScalar('has: colon'))->toBe('"has: colon"');
    expect(ExportHelpers::yamlScalar("multi\nline"))->toBe('"multi\nline"');
});
