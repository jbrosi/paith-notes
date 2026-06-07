<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Import;

/**
 * Rewrite all UUIDs in a parsed export so the data can be imported into a fresh
 * nook without colliding with any existing rows in global.* tables.
 *
 * The remap covers:
 *   • top-level entity IDs (types, attributes, predicates, notes, links)
 *   • foreign-key fields between those entities
 *   • attribute_layout panel attribute refs + config_overrides keys
 *   • graph attribute values that point at a root note
 *   • same-nook [[note:uuid]] and ![alt](note:uuid) refs inside note content
 *
 * Cross-nook refs [[note:nookId/noteId]] are left untouched — they point at a
 * different nook, not the one being imported.
 */
final class RemapIds
{
    private const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    /**
     * @param array<string, mixed> $data  Output of NookImportController::parseZip()
     * @return array{0: array<string, mixed>, 1: array{types: array<string,string>, attributes: array<string,string>, predicates: array<string,string>, notes: array<string,string>, links: array<string,string>}}
     */
    public static function remap(array $data): array
    {
        $types = self::asList($data['types'] ?? []);
        $attrs = self::asList($data['attributes'] ?? []);
        $preds = self::asList($data['predicates'] ?? []);
        $rules = self::asList($data['predicate_rules'] ?? []);
        $notes = self::asList($data['notes'] ?? []);
        $links = self::asList($data['links'] ?? []);

        $typeMap = self::buildIdMap($types);
        $attrMap = self::buildIdMap($attrs);
        $predMap = self::buildIdMap($preds);
        $noteMap = self::buildIdMap($notes);
        $linkMap = self::buildIdMap($links);

        // Kind lookup keyed on OLD attribute id (before rekey) so we can decide
        // which note-attribute values need value-level remapping.
        $attrKindByOldId = [];
        foreach ($attrs as $a) {
            $id = self::strVal($a['id'] ?? null);
            $kind = self::strVal($a['kind'] ?? null);
            if ($id !== '') {
                $attrKindByOldId[$id] = $kind;
            }
        }

        $newTypes = array_map(
            static fn(array $t) => self::remapType($t, $typeMap, $attrMap),
            $types,
        );

        $newAttrs = array_map(
            static fn(array $a) => self::remapAttribute($a, $attrMap, $typeMap),
            $attrs,
        );

        $newPreds = array_map(
            static fn(array $p) => self::remapPredicate($p, $predMap),
            $preds,
        );

        $newRules = array_map(
            static fn(array $r) => self::remapPredicateRule($r, $predMap, $typeMap),
            $rules,
        );

        $newNotes = array_map(
            static fn(array $n) => self::remapNote($n, $noteMap, $typeMap, $attrMap, $attrKindByOldId),
            $notes,
        );

        $newLinks = array_map(
            static fn(array $l) => self::remapLink($l, $linkMap, $predMap, $noteMap),
            $links,
        );

        $remapped = $data;
        $remapped['types'] = $newTypes;
        $remapped['attributes'] = $newAttrs;
        $remapped['predicates'] = $newPreds;
        $remapped['predicate_rules'] = $newRules;
        $remapped['notes'] = $newNotes;
        $remapped['links'] = $newLinks;

        // Nook block keeps its name/purpose but loses its old id — the caller
        // will create a fresh nook row and pass that id to importIntoNook.
        if (isset($remapped['nook']) && is_array($remapped['nook'])) {
            unset($remapped['nook']['id']);
        }

        return [
            $remapped,
            [
                'types' => $typeMap,
                'attributes' => $attrMap,
                'predicates' => $predMap,
                'notes' => $noteMap,
                'links' => $linkMap,
            ],
        ];
    }

    /**
     * @param array<string, mixed> $t
     * @param array<string, string> $typeMap
     * @param array<string, string> $attrMap
     * @return array<string, mixed>
     */
    private static function remapType(array $t, array $typeMap, array $attrMap): array
    {
        $oldId = self::strVal($t['id'] ?? null);
        if ($oldId !== '') {
            $t['id'] = $typeMap[$oldId] ?? $t['id'];
        }
        $oldParent = self::strVal($t['parent_id'] ?? null);
        if ($oldParent !== '') {
            $t['parent_id'] = $typeMap[$oldParent] ?? null;
        }

        if (isset($t['attribute_layout']) && is_array($t['attribute_layout'])) {
            $t['attribute_layout'] = self::remapAttributeLayout($t['attribute_layout'], $attrMap);
        }

        if (isset($t['config_overrides']) && is_array($t['config_overrides'])) {
            $t['config_overrides'] = self::rekey($t['config_overrides'], $attrMap);
        }

        return $t;
    }

    /**
     * @param array<mixed, mixed> $layout
     * @param array<string, string> $attrMap
     * @return array<mixed, mixed>
     */
    private static function remapAttributeLayout(array $layout, array $attrMap): array
    {
        if (!isset($layout['panels']) || !is_array($layout['panels'])) {
            return $layout;
        }
        foreach ($layout['panels'] as &$panel) {
            if (!is_array($panel) || !isset($panel['attributes']) || !is_array($panel['attributes'])) {
                continue;
            }
            $panel['attributes'] = array_map(
                static fn($id) => is_string($id) && isset($attrMap[$id]) ? $attrMap[$id] : $id,
                $panel['attributes'],
            );
        }
        unset($panel);
        return $layout;
    }

    /**
     * @param array<string, mixed> $a
     * @param array<string, string> $attrMap
     * @param array<string, string> $typeMap
     * @return array<string, mixed>
     */
    private static function remapAttribute(array $a, array $attrMap, array $typeMap): array
    {
        $oldId = self::strVal($a['id'] ?? null);
        if ($oldId !== '') {
            $a['id'] = $attrMap[$oldId] ?? $a['id'];
        }
        $oldTypeId = self::strVal($a['type_id'] ?? null);
        if ($oldTypeId !== '') {
            $a['type_id'] = $typeMap[$oldTypeId] ?? $a['type_id'];
        }
        return $a;
    }

    /**
     * @param array<string, mixed> $p
     * @param array<string, string> $predMap
     * @return array<string, mixed>
     */
    private static function remapPredicate(array $p, array $predMap): array
    {
        $oldId = self::strVal($p['id'] ?? null);
        if ($oldId !== '') {
            $p['id'] = $predMap[$oldId] ?? $p['id'];
        }
        return $p;
    }

    /**
     * @param array<string, mixed> $r
     * @param array<string, string> $predMap
     * @param array<string, string> $typeMap
     * @return array<string, mixed>
     */
    private static function remapPredicateRule(array $r, array $predMap, array $typeMap): array
    {
        $oldPred = self::strVal($r['predicate_id'] ?? null);
        if ($oldPred !== '') {
            $r['predicate_id'] = $predMap[$oldPred] ?? $r['predicate_id'];
        }
        $oldSrc = self::strVal($r['source_type_id'] ?? null);
        if ($oldSrc !== '') {
            $r['source_type_id'] = $typeMap[$oldSrc] ?? null;
        }
        $oldTgt = self::strVal($r['target_type_id'] ?? null);
        if ($oldTgt !== '') {
            $r['target_type_id'] = $typeMap[$oldTgt] ?? null;
        }
        return $r;
    }

    /**
     * @param array<string, mixed> $n
     * @param array<string, string> $noteMap
     * @param array<string, string> $typeMap
     * @param array<string, string> $attrMap
     * @param array<string, string> $attrKindByOldId
     * @return array<string, mixed>
     */
    private static function remapNote(
        array $n,
        array $noteMap,
        array $typeMap,
        array $attrMap,
        array $attrKindByOldId,
    ): array {
        $oldId = self::strVal($n['id'] ?? null);
        if ($oldId !== '') {
            $n['id'] = $noteMap[$oldId] ?? $n['id'];
        }
        $oldType = self::strVal($n['type_id'] ?? null);
        if ($oldType !== '') {
            $n['type_id'] = $typeMap[$oldType] ?? null;
        }

        if (isset($n['attributes']) && is_array($n['attributes'])) {
            $newAttrs = [];
            foreach ($n['attributes'] as $oldAttrId => $value) {
                $oldAttrIdStr = (string) $oldAttrId;
                $newAttrId = $attrMap[$oldAttrIdStr] ?? $oldAttrIdStr;
                $kind = $attrKindByOldId[$oldAttrIdStr] ?? '';
                $newAttrs[$newAttrId] = self::remapAttributeValue($value, $kind, $noteMap);
            }
            $n['attributes'] = $newAttrs;
        }

        if (isset($n['content']) && is_string($n['content'])) {
            $n['content'] = self::remapContent($n['content'], $noteMap);
        }

        return $n;
    }

    /**
     * @param array<string, string> $noteMap
     */
    private static function remapAttributeValue(mixed $value, string $kind, array $noteMap): mixed
    {
        if ($kind === 'graph' && is_array($value) && isset($value['rootNoteId']) && is_string($value['rootNoteId'])) {
            $value['rootNoteId'] = $noteMap[$value['rootNoteId']] ?? $value['rootNoteId'];
        }
        return $value;
    }

    /**
     * Rewrite [[note:uuid]] and ![alt](note:uuid) using the note id map.
     * Cross-nook references [[note:nookId/noteId]] and ![](note:nookId/noteId)
     * point at a different nook and are passed through unchanged.
     *
     * @param array<string, string> $noteMap
     */
    private static function remapContent(string $content, array $noteMap): string
    {
        $uuid = self::UUID;

        $pattern = '/
            \[\[note:(' . $uuid . ')\/(' . $uuid . ')\]\]      # cross-nook wikilink
            | \[\[note:(' . $uuid . ')\]\]                       # same-nook wikilink
            | (\!\[[^\]]*\])\(note:(' . $uuid . ')\/(' . $uuid . ')\)  # cross-nook image
            | (\!\[[^\]]*\])\(note:(' . $uuid . ')\)             # same-nook image
        /xi';

        // One indicator group per alternative avoids redundant && checks that
        // confuse phpstan's regex narrowing (after $m[1] !== '', it already
        // knows $m[2] is non-empty for that alternative).
        return preg_replace_callback(
            $pattern,
            static function (array $m) use ($noteMap): string {
                // Cross-nook wikilink: groups 1, 2 set — leave as-is
                if ($m[1] !== '') {
                    return $m[0];
                }
                // Same-nook wikilink: group 3 set
                if ($m[3] !== '') {
                    $new = $noteMap[$m[3]] ?? $m[3];
                    return "[[note:{$new}]]";
                }
                // Cross-nook image: groups 4, 5, 6 set — leave as-is
                if ($m[4] !== '') {
                    return $m[0];
                }
                // Same-nook image: groups 7, 8 set (only remaining alternative)
                $new = $noteMap[$m[8]] ?? $m[8];
                return "{$m[7]}(note:{$new})";
            },
            $content,
        ) ?? $content;
    }

    /**
     * @param array<string, mixed> $l
     * @param array<string, string> $linkMap
     * @param array<string, string> $predMap
     * @param array<string, string> $noteMap
     * @return array<string, mixed>
     */
    private static function remapLink(array $l, array $linkMap, array $predMap, array $noteMap): array
    {
        $oldId = self::strVal($l['id'] ?? null);
        if ($oldId !== '') {
            $l['id'] = $linkMap[$oldId] ?? $l['id'];
        }
        $oldPred = self::strVal($l['predicate_id'] ?? null);
        if ($oldPred !== '') {
            $l['predicate_id'] = $predMap[$oldPred] ?? $l['predicate_id'];
        }
        $oldSrc = self::strVal($l['source_note_id'] ?? null);
        if ($oldSrc !== '') {
            $l['source_note_id'] = $noteMap[$oldSrc] ?? $l['source_note_id'];
        }
        $oldTgt = self::strVal($l['target_note_id'] ?? null);
        if ($oldTgt !== '') {
            $l['target_note_id'] = $noteMap[$oldTgt] ?? $l['target_note_id'];
        }
        return $l;
    }

    /**
     * Build a fresh-UUID map for an entity list keyed by id.
     *
     * @param list<array<string, mixed>> $items
     * @return array<string, string>
     */
    private static function buildIdMap(array $items): array
    {
        $map = [];
        foreach ($items as $it) {
            $old = self::strVal($it['id'] ?? null);
            if ($old === '' || isset($map[$old])) {
                continue;
            }
            $map[$old] = self::uuidV4();
        }
        return $map;
    }

    /**
     * Rekey an associative array of UUID-keyed values through a map.
     * Keys missing from the map are preserved (defensive — shouldn't happen in
     * well-formed exports but we don't want to silently drop config).
     *
     * @param array<mixed, mixed> $assoc
     * @param array<string, string> $map
     * @return array<mixed, mixed>
     */
    private static function rekey(array $assoc, array $map): array
    {
        $out = [];
        foreach ($assoc as $key => $value) {
            $newKey = is_string($key) && isset($map[$key]) ? $map[$key] : $key;
            $out[$newKey] = $value;
        }
        return $out;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private static function asList(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $item) {
            if (is_array($item)) {
                /** @var array<string, mixed> $item */
                $out[] = $item;
            }
        }
        return $out;
    }

    private static function strVal(mixed $v): string
    {
        return is_scalar($v) ? (string) $v : '';
    }

    private static function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
