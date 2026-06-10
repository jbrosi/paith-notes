<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Controller\Import\RemapIds;

function fixture_export_data(): array
{
    // Two types: a parent + a child
    $parentTypeId = '11111111-1111-4111-8111-111111111111';
    $childTypeId  = '22222222-2222-4222-8222-222222222222';

    // Two attributes on the child type, including a graph attribute
    $attrTextId   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $attrGraphId  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    $predId       = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $note1Id      = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    $note2Id      = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    $linkId       = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    // Cross-nook ref — should NOT be remapped
    $foreignNookId = '99999999-9999-4999-8999-999999999999';
    $foreignNoteId = '88888888-8888-4888-8888-888888888888';

    return [
        'version' => 1,
        'nook' => ['id' => 'oldnookid-1111-1111-1111-oldnookid1111', 'name' => 'Source'],
        'types' => [
            [
                'id' => $parentTypeId,
                'key' => 'base',
                'label' => 'Base',
                'parent_id' => null,
            ],
            [
                'id' => $childTypeId,
                'key' => 'page',
                'label' => 'Page',
                'parent_id' => $parentTypeId,
                'attribute_layout' => [
                    'panels' => [
                        ['key' => 'main', 'position' => 'main', 'attributes' => [$attrTextId, $attrGraphId]],
                    ],
                ],
                'config_overrides' => [
                    $attrTextId => ['hidden' => false],
                ],
            ],
        ],
        'attributes' => [
            ['id' => $attrTextId,  'type_id' => $childTypeId, 'key' => 'body',  'name' => 'Body',  'kind' => 'text',  'indexed' => true],
            ['id' => $attrGraphId, 'type_id' => $childTypeId, 'key' => 'graph', 'name' => 'Graph', 'kind' => 'graph', 'indexed' => false],
        ],
        'predicates' => [
            ['id' => $predId, 'key' => 'rel', 'forward_label' => 'relates to', 'reverse_label' => 'related from'],
        ],
        'predicate_rules' => [
            [
                'predicate_id' => $predId,
                'source_type_id' => $childTypeId,
                'target_type_id' => $childTypeId,
                'include_source_subtypes' => true,
                'include_target_subtypes' => true,
            ],
        ],
        'notes' => [
            [
                'id' => $note1Id,
                'title' => 'Note one',
                'type_id' => $childTypeId,
                'content' => "Hello [[note:{$note2Id}]] and image ![pic](note:{$note2Id}). "
                           . "Cross [[note:{$foreignNookId}/{$foreignNoteId}]] stays.",
                'attributes' => [
                    $attrTextId  => 'plain text',
                    $attrGraphId => ['rootNoteId' => $note2Id, 'depth' => 2],
                ],
            ],
            [
                'id' => $note2Id,
                'title' => 'Note two',
                'type_id' => $childTypeId,
                'content' => '',
                'attributes' => new stdClass(),
            ],
        ],
        'links' => [
            ['id' => $linkId, 'predicate_id' => $predId, 'source_note_id' => $note1Id, 'target_note_id' => $note2Id],
        ],
    ];
}

it('regenerates ids for every entity', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    foreach (['types', 'attributes', 'predicates', 'notes', 'links'] as $coll) {
        $oldIds = array_column($in[$coll], 'id');
        $newIds = array_column($out[$coll], 'id');
        expect(count($newIds))->toBe(count($oldIds));
        expect(array_intersect($oldIds, $newIds))->toBe([]);
    }

    // Maps cover everything
    expect(array_keys($maps['types']))->toEqualCanonicalizing(array_column($in['types'], 'id'));
    expect(array_keys($maps['notes']))->toEqualCanonicalizing(array_column($in['notes'], 'id'));
});

it('remaps type parent_id via type map', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $childOld = $in['types'][1];
    $childNew = $out['types'][1];

    expect($childNew['parent_id'])->toBe($maps['types'][$childOld['parent_id']]);
});

it('remaps attribute_layout and config_overrides keys via attribute map', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $childNew = $out['types'][1];

    $panelAttrs = $childNew['attribute_layout']['panels'][0]['attributes'];
    expect($panelAttrs)->toBe([
        $maps['attributes']['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        $maps['attributes']['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ]);

    expect(array_keys($childNew['config_overrides']))->toBe([
        $maps['attributes']['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ]);
});

it('remaps attribute type_id via type map', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    foreach ($out['attributes'] as $i => $a) {
        $oldTypeId = $in['attributes'][$i]['type_id'];
        expect($a['type_id'])->toBe($maps['types'][$oldTypeId]);
    }
});

it('remaps predicate_rules predicate_id and type ids', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $rule = $out['predicate_rules'][0];
    expect($rule['predicate_id'])->toBe($maps['predicates'][$in['predicate_rules'][0]['predicate_id']]);
    expect($rule['source_type_id'])->toBe($maps['types'][$in['predicate_rules'][0]['source_type_id']]);
    expect($rule['target_type_id'])->toBe($maps['types'][$in['predicate_rules'][0]['target_type_id']]);
});

it('remaps note type_id, attribute keys, and graph rootNoteId', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $note1 = $out['notes'][0];
    expect($note1['type_id'])->toBe($maps['types'][$in['notes'][0]['type_id']]);

    // Attribute keys remapped
    $expectedKeys = [
        $maps['attributes']['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        $maps['attributes']['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ];
    expect(array_keys($note1['attributes']))->toEqualCanonicalizing($expectedKeys);

    // Graph rootNoteId remapped via note map
    $newGraphKey = $maps['attributes']['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    expect($note1['attributes'][$newGraphKey]['rootNoteId'])
        ->toBe($maps['notes']['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);

    // Plain text attribute value preserved
    $newTextKey = $maps['attributes']['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
    expect($note1['attributes'][$newTextKey])->toBe('plain text');
});

it('rewrites same-nook content references and preserves cross-nook refs', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $newNote2Id = $maps['notes']['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
    $content = $out['notes'][0]['content'];

    // Same-nook wikilink + image remapped
    expect($content)->toContain("[[note:{$newNote2Id}]]");
    expect($content)->toContain("(note:{$newNote2Id})");

    // Old same-nook UUIDs gone
    expect($content)->not()->toContain('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    // Cross-nook reference untouched
    expect($content)->toContain('[[note:99999999-9999-4999-8999-999999999999/88888888-8888-4888-8888-888888888888]]');
});

it('remaps link fields via predicate and note maps', function (): void {
    $in = fixture_export_data();
    [$out, $maps] = RemapIds::remap($in);

    $l = $out['links'][0];
    expect($l['predicate_id'])->toBe($maps['predicates'][$in['links'][0]['predicate_id']]);
    expect($l['source_note_id'])->toBe($maps['notes'][$in['links'][0]['source_note_id']]);
    expect($l['target_note_id'])->toBe($maps['notes'][$in['links'][0]['target_note_id']]);
});

it('drops the source nook id from the manifest block', function (): void {
    $in = fixture_export_data();
    [$out] = RemapIds::remap($in);

    expect($out['nook'])->not()->toHaveKey('id');
    expect($out['nook']['name'])->toBe('Source');
});

it('produces no shared ids between input and output anywhere', function (): void {
    $in = fixture_export_data();
    [$out] = RemapIds::remap($in);

    $inputIds = [];
    foreach (['types', 'attributes', 'predicates', 'notes', 'links'] as $c) {
        foreach ($in[$c] as $row) {
            if (isset($row['id'])) {
                $inputIds[$row['id']] = true;
            }
        }
    }

    $walk = static function (mixed $v) use (&$walk, $inputIds): void {
        if (is_array($v)) {
            foreach ($v as $k => $vv) {
                if (is_string($k) && isset($inputIds[$k])) {
                    // Attribute keys / config_overrides keys must not be old ids
                    throw new RuntimeException("stale id leaked as key: {$k}");
                }
                $walk($vv);
            }
        } elseif (is_string($v) && isset($inputIds[$v])) {
            throw new RuntimeException("stale id leaked as value: {$v}");
        }
    };

    // Cross-nook UUIDs are expected to remain in content — strip them before scanning
    $scrubbed = $out;
    foreach ($scrubbed['notes'] as &$n) {
        if (isset($n['content']) && is_string($n['content'])) {
            $n['content'] = preg_replace(
                '#(\[\[|\()note:[0-9a-f-]{36}/[0-9a-f-]{36}(\]\]|\))#i',
                '',
                $n['content'],
            ) ?? $n['content'];
        }
    }
    unset($n);

    $walk($scrubbed);
    expect(true)->toBeTrue(); // no exception thrown
});
