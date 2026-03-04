<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Service\MentionsService;

it('parses basic note links and preserves order', function (): void {
    $a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    $md = 'See [First](note:' . $a . ') and then [Second](note:' . $b . ').';

    $mentions = MentionsService::parseMentionsFromMarkdown($md);
    expect($mentions)->toBeArray();
    expect(count($mentions))->toBe(2);

    expect((string)($mentions[0]['target_note_id'] ?? ''))->toBe($a);
    expect((string)($mentions[0]['link_title'] ?? ''))->toBe('First');

    expect((string)($mentions[1]['target_note_id'] ?? ''))->toBe($b);
    expect((string)($mentions[1]['link_title'] ?? ''))->toBe('Second');

    expect((int)($mentions[0]['offset'] ?? -1))->toBeLessThan((int)($mentions[1]['offset'] ?? -1));
});

it('parses image embeds and allows empty titles', function (): void {
    $id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    $md = '![](note:' . $id . ')';

    $mentions = MentionsService::parseMentionsFromMarkdown($md);
    expect(count($mentions))->toBe(1);
    expect((string)($mentions[0]['target_note_id'] ?? ''))->toBe($id);
    expect((string)($mentions[0]['link_title'] ?? ''))->toBe('');
});

it('prefers caption over link title when present', function (): void {
    $id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    $md = '[Ignored](note:' . $id . ' "Custom")';

    $mentions = MentionsService::parseMentionsFromMarkdown($md);
    expect(count($mentions))->toBe(1);
    expect((string)($mentions[0]['target_note_id'] ?? ''))->toBe($id);
    expect((string)($mentions[0]['link_title'] ?? ''))->toBe('Custom');
});

it('ignores non-matching note links', function (): void {
    $md = 'No mention here: [X](note:not-a-uuid) and [Y](http://example.com).';

    $mentions = MentionsService::parseMentionsFromMarkdown($md);
    expect($mentions)->toBeArray();
    expect(count($mentions))->toBe(0);
});
