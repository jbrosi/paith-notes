<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

use Paith\Notes\Api\Http\HttpError;
use PDO;
use Paith\Notes\Shared\Db\Row;

/**
 * Validates attribute configs (type-level) and attribute values (note-level).
 */
final class AttributeValidator
{
    private const VALID_DIRECTIONS = ['outgoing', 'incoming', 'both'];
    private const VALID_CONTENT_MODES = ['markdown', 'plain', 'code', 'hidden'];
    private const VALID_TEXT_DISPLAYS = ['', 'paragraph'];
    private const VALID_NUMBER_DISPLAYS = ['', 'rating', 'duration', 'currency'];
    private const VALID_FILE_DISPLAYS = ['', 'download', 'preview', 'player'];
    private const VALID_GRAPH_LAYOUTS = ['force', 'tree', 'radial'];

    // ─── Config Validation ───────────────────────────────────────────────

    /**
     * Validate attribute config for a given kind.
     * @param array<string, mixed> $config
     * @throws HttpError on invalid config
     */
    public static function validateConfig(string $kind, array $config): void
    {
        switch ($kind) {
            case 'select':
            case 'multi_select':
                $options = $config['options'] ?? null;
                if (!is_array($options) || $options === []) {
                    throw new HttpError($kind . ' kind requires a non-empty "options" array in config', 400);
                }
                $stringOptions = [];
                foreach ($options as $opt) {
                    if (!is_string($opt) || trim($opt) === '') {
                        throw new HttpError($kind . ' options must be non-empty strings', 400);
                    }
                    $stringOptions[] = $opt;
                }
                if (count($stringOptions) !== count(array_unique($stringOptions))) {
                    throw new HttpError($kind . ' options must be unique', 400);
                }
                break;

            case 'text':
                $display = $config['display'] ?? '';
                if ($display !== '' && !in_array($display, self::VALID_TEXT_DISPLAYS, true)) {
                    throw new HttpError('text display must be one of: (empty), paragraph', 400);
                }
                break;

            case 'number':
                $display = $config['display'] ?? '';
                if ($display !== '' && !in_array($display, self::VALID_NUMBER_DISPLAYS, true)) {
                    throw new HttpError('number display must be one of: ' . implode(', ', array_map(fn($d) => $d === '' ? '(empty)' : $d, self::VALID_NUMBER_DISPLAYS)), 400);
                }
                if (isset($config['max'])) {
                    if (!is_numeric($config['max'])) {
                        throw new HttpError('number max must be numeric', 400);
                    }
                    $max = (int)$config['max'];
                    if ($max < 1 || $max > 100) {
                        throw new HttpError('number max must be between 1 and 100', 400);
                    }
                }
                if ($display === 'currency') {
                    // ISO 4217 codes are 3 uppercase letters; default to USD
                    // when omitted but reject malformed overrides so a typo
                    // doesn't silently become e.g. "U$D".
                    $currency = $config['currency'] ?? 'USD';
                    if (!is_string($currency) || !preg_match('/^[A-Z]{3}$/', $currency)) {
                        throw new HttpError('number currency must be a 3-letter ISO code (e.g. USD)', 400);
                    }
                }
                break;

            case 'file':
                $display = $config['display'] ?? '';
                if ($display !== '' && !in_array($display, self::VALID_FILE_DISPLAYS, true)) {
                    throw new HttpError('file display must be one of: (empty), download, preview, player', 400);
                }
                break;

            case 'content':
                $mode = $config['mode'] ?? 'markdown';
                if (!in_array($mode, self::VALID_CONTENT_MODES, true)) {
                    throw new HttpError('content mode must be one of: ' . implode(', ', self::VALID_CONTENT_MODES), 400);
                }
                break;

            case 'linked_notes':
            case 'mentions':
                $direction = $config['direction'] ?? 'both';
                if (!in_array($direction, self::VALID_DIRECTIONS, true)) {
                    throw new HttpError('direction must be one of: ' . implode(', ', self::VALID_DIRECTIONS), 400);
                }
                break;

            case 'history':
                if (isset($config['limit'])) {
                    if (!is_numeric($config['limit'])) {
                        throw new HttpError('history limit must be numeric', 400);
                    }
                    $limit = (int)$config['limit'];
                    if ($limit < 0 || $limit > 100) {
                        throw new HttpError('history limit must be between 0 and 100', 400);
                    }
                }
                break;

            case 'toc':
                if (isset($config['max_depth'])) {
                    if (!is_numeric($config['max_depth'])) {
                        throw new HttpError('toc max_depth must be numeric', 400);
                    }
                    $depth = (int)$config['max_depth'];
                    if ($depth < 1 || $depth > 6) {
                        throw new HttpError('toc max_depth must be between 1 and 6', 400);
                    }
                }
                break;

            case 'metadata':
                foreach (['show_version', 'show_created', 'show_updated', 'show_views'] as $flag) {
                    if (isset($config[$flag]) && !is_bool($config[$flag])) {
                        throw new HttpError("metadata $flag must be boolean", 400);
                    }
                }
                break;

            // boolean, date, date_range, url, graph, view: no special config validation
        }
    }

    // ─── Value Validation ────────────────────────────────────────────────

    /**
     * Validate a single attribute value against its kind and config.
     * @param array<string, mixed> $config
     * @throws HttpError on invalid value
     */
    public static function validateValue(string $attrName, string $kind, array $config, mixed $value): void
    {
        // null means "clear this attribute" — always valid
        if ($value === null) {
            return;
        }

        $prefix = "attribute \"$attrName\"";

        switch ($kind) {
            case 'text':
                if (!is_string($value)) {
                    throw new HttpError("$prefix: text value must be a string", 400);
                }
                break;

            case 'number':
                if (!is_numeric($value)) {
                    throw new HttpError("$prefix: number value must be numeric", 400);
                }
                $display = $config['display'] ?? '';
                if ($display === 'rating') {
                    $maxRaw = $config['max'] ?? 5;
                    $max = is_numeric($maxRaw) ? (int)$maxRaw : 5;
                    $num = is_int($value) ? $value : (is_float($value) ? $value : (int)$value);
                    if ($num < 0 || $num > $max) {
                        throw new HttpError("$prefix: rating value must be between 0 and $max", 400);
                    }
                }
                break;

            case 'boolean':
                if (!is_bool($value)) {
                    throw new HttpError("$prefix: boolean value must be true or false", 400);
                }
                break;

            case 'date':
                if (!is_string($value)) {
                    throw new HttpError("$prefix: date value must be a string", 400);
                }
                if ($value !== '' && !self::isValidDate($value)) {
                    throw new HttpError("$prefix: date value must be YYYY-MM-DD format", 400);
                }
                break;

            case 'date_range':
                if (!is_array($value)) {
                    throw new HttpError("$prefix: date_range value must be an object with from/to", 400);
                }
                $from = $value['from'] ?? null;
                $to = $value['to'] ?? null;
                if ($from !== null && $from !== '' && (!is_string($from) || !self::isValidDate($from))) {
                    throw new HttpError("$prefix: date_range 'from' must be YYYY-MM-DD format", 400);
                }
                if ($to !== null && $to !== '' && (!is_string($to) || !self::isValidDate($to))) {
                    throw new HttpError("$prefix: date_range 'to' must be YYYY-MM-DD format", 400);
                }
                break;

            case 'select':
                if (!is_string($value)) {
                    throw new HttpError("$prefix: select value must be a string", 400);
                }
                if ($value !== '') {
                    $options = $config['options'] ?? [];
                    if (is_array($options) && !in_array($value, $options, true)) {
                        $stringOptions = array_filter($options, 'is_string');
                        throw new HttpError("$prefix: select value must be one of: " . implode(', ', $stringOptions), 400);
                    }
                }
                break;

            case 'multi_select':
                if (!is_array($value)) {
                    throw new HttpError("$prefix: multi_select value must be an array", 400);
                }
                $options = $config['options'] ?? [];
                if (is_array($options)) {
                    foreach ($value as $item) {
                        if (!is_string($item)) {
                            throw new HttpError("$prefix: multi_select items must be strings", 400);
                        }
                        if (!in_array($item, $options, true)) {
                            throw new HttpError("$prefix: multi_select value \"$item\" is not a valid option", 400);
                        }
                    }
                }
                break;

            case 'url':
                if (!is_string($value)) {
                    throw new HttpError("$prefix: url value must be a string", 400);
                }
                if ($value !== '' && !filter_var($value, FILTER_VALIDATE_URL)) {
                    throw new HttpError("$prefix: url value must be a valid URL", 400);
                }
                break;

            case 'dimension':
                if (!is_array($value)) {
                    throw new HttpError("$prefix: dimension value must be an object with width/height", 400);
                }
                $width = $value['width'] ?? null;
                $height = $value['height'] ?? null;
                // Both must be present + positive integers. Zero/negative
                // dimensions don't represent anything meaningful and would
                // confuse downstream renderers.
                foreach (['width' => $width, 'height' => $height] as $label => $v) {
                    if (!is_int($v) && !(is_string($v) && ctype_digit($v))) {
                        throw new HttpError("$prefix: dimension $label must be a positive integer", 400);
                    }
                    if ((int)$v < 1) {
                        throw new HttpError("$prefix: dimension $label must be >= 1", 400);
                    }
                }
                break;

            case 'graph':
                if (!is_array($value)) {
                    throw new HttpError("$prefix: graph value must be an object", 400);
                }
                if (isset($value['rootNoteId']) && !is_string($value['rootNoteId'])) {
                    throw new HttpError("$prefix: graph rootNoteId must be a string", 400);
                }
                if (isset($value['depth'])) {
                    if (!is_numeric($value['depth'])) {
                        throw new HttpError("$prefix: graph depth must be numeric", 400);
                    }
                    $depth = (int)$value['depth'];
                    if ($depth < 1 || $depth > 5) {
                        throw new HttpError("$prefix: graph depth must be between 1 and 5", 400);
                    }
                }
                if (isset($value['layout']) && !in_array($value['layout'], self::VALID_GRAPH_LAYOUTS, true)) {
                    throw new HttpError("$prefix: graph layout must be one of: " . implode(', ', self::VALID_GRAPH_LAYOUTS), 400);
                }
                break;

            // view: accepts arbitrary config object
            case 'view':
                if (!is_array($value)) {
                    throw new HttpError("$prefix: view value must be an object", 400);
                }
                break;

            // Presentational kinds should not have note-level values set directly
            // but we won't reject them — just ignore silently (they may come from legacy data)
        }
    }

    /**
     * Validate all attribute values for a note against its type's resolved attributes.
     * @param array<string, mixed> $values Key = attribute UUID, value = attribute value
     * @param array<int, array<string, mixed>> $resolvedAttributes From resolveInheritedAttributes
     * @throws HttpError on invalid values
     */
    public static function validateNoteAttributes(array $values, array $resolvedAttributes): void
    {
        // Build lookup: attr ID → { kind, config, name }
        $attrMap = [];
        foreach ($resolvedAttributes as $attr) {
            $id = $attr['id'] ?? '';
            if (is_string($id) && $id !== '') {
                $attrMap[$id] = $attr;
            }
        }

        foreach ($values as $attrId => $value) {
            // null means "delete" — always valid
            if ($value === null) {
                continue;
            }
            // Unknown attribute IDs are silently ignored (may be orphaned/archived)
            if (!isset($attrMap[$attrId])) {
                continue;
            }
            $attr = $attrMap[$attrId];
            $kind = Row::str($attr, 'kind');
            $rawConfig = $attr['config'] ?? null;
            $config = [];
            if (is_array($rawConfig)) {
                foreach ($rawConfig as $ck => $cv) {
                    if (is_string($ck)) {
                        $config[$ck] = $cv;
                    }
                }
            }
            $name = is_scalar($attr['name'] ?? null) ? (string)$attr['name'] : $attrId;
            self::validateValue($name, $kind, $config, $value);
        }
    }

    /**
     * Resolve type attributes and validate note attribute values in one call.
     * @param array<string, mixed> $values Key = attribute UUID, value = attribute value
     * @throws HttpError on invalid values
     */
    public static function validateNoteAttributesForType(PDO $pdo, string $nookId, string $typeId, array $values): void
    {
        if ($values === [] || $typeId === '') {
            return;
        }

        $stmt = $pdo->prepare(
            'with recursive type_tree as (
                select id from global.note_types where id = :type_id and nook_id = :nook_id
                union all
                select t.parent_id from global.note_types t
                join type_tree tt on t.id = tt.id
                where t.parent_id is not null
            )
            select ta.id, ta.name, ta.kind, ta.config
            from global.type_attributes ta
            join type_tree tt on ta.type_id = tt.id'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->execute();

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $attrs = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $id = Row::str($r, 'id');
            $config = is_scalar($r['config'] ?? null) ? json_decode((string)$r['config'], true) : [];
            $attrs[] = [
                'id' => $id,
                'name' => Row::str($r, 'name'),
                'kind' => Row::str($r, 'kind'),
                'config' => is_array($config) ? $config : [],
            ];
        }

        self::validateNoteAttributes($values, $attrs);
    }

    private static function isValidDate(string $value): bool
    {
        return (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)
            && strtotime($value) !== false;
    }
}
