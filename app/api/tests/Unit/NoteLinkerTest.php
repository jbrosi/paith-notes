<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Controller\Export\NoteLinker;

it('rewrites same-nook wikilinks to relative paths', function (): void {
    $noteMap = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' => 'Note/Hello.md',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' => 'Note/Meeting/Standup.md',
    ];
    $noteTitles = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' => 'Hello',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' => 'Standup',
    ];

    $content = 'See [[note:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]] for details.';
    $result = NoteLinker::rewriteToRelative($content, $noteMap, $noteTitles, 'Note/Meeting');

    expect($result)->toBe('See [Hello](../Hello.md) for details.');
});

it('rewrites cross-nook wikilinks to absolute URLs', function (): void {
    $content = 'See [[note:cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd]] for details.';
    $result = NoteLinker::rewriteToRelative($content, [], [], 'Note', [], [], 'https://app.example.com');

    expect($result)->toContain('https://app.example.com/nooks/cccccccc-cccc-4ccc-8ccc-cccccccccccc/notes/dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect($result)->not->toContain('[[note:');
});

it('rewrites same-nook image embeds to file paths when available', function (): void {
    $noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $noteFiles = [
        $noteId => [
            ['filename' => 'photo', 'extension' => 'jpg', 'attribute_id' => 'attr-1', 'object_key' => 'x'],
        ],
    ];
    $attrById = ['attr-1' => ['name' => 'Photo', 'kind' => 'file']];

    $content = "![My Image](note:{$noteId})";
    $result = NoteLinker::rewriteToRelative($content, [], [], 'Note/Meeting', $noteFiles, $attrById);

    expect($result)->toContain("files/{$noteId}/Photo/photo.jpg");
    expect($result)->not->toContain('note:');
});

it('rewrites relative links back to internal format', function (): void {
    $pathToId = ['Note/Hello.md' => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];

    $content = 'See [Hello](../Hello.md) for details.';
    $result = NoteLinker::rewriteToInternal($content, 'notes/Note/Meeting/Standup.md', $pathToId);

    expect($result)->toBe('See [[note:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]] for details.');
});

it('preserves non-matching links', function (): void {
    $content = 'See [External](https://example.com) and [other](./local.txt) for details.';
    $result = NoteLinker::rewriteToRelative($content, [], [], 'Note');

    expect($result)->toBe($content);
});
