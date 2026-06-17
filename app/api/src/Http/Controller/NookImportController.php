<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Controller\Export;
use Paith\Notes\Shared\Db\Row;
use PDO;
use ZipArchive;

/**
 * Import a nook from a ZIP export archive.
 *
 * Expected structure:
 *   manifest.json           — { version, nook }
 *   meta/types.json         — types array
 *   meta/attributes.json    — attributes array
 *   meta/predicates.json    — { predicates, rules }
 *   meta/links.json         — links array
 *   notes/<id>.json         — one per note
 *   files/                  — (future)
 */
final class NookImportController
{
    private const AI_USER_ID = 'deadc0ff-ee00-4000-8000-000000000000';

    /**
     * Parse a ZIP archive into the import data structure.
     *
     * @return array{
     *   version: int,
     *   nook: array<string, mixed>,
     *   types: list<array<string, mixed>>,
     *   attributes: list<array<string, mixed>>,
     *   notes: list<array<string, mixed>>,
     *   predicates: list<array<string, mixed>>,
     *   predicate_rules: list<array<string, mixed>>,
     *   links: list<array<string, mixed>>
     * }
     */
    public static function parseZip(string $zipPath): array
    {
        $zip = new ZipArchive();
        if ($zip->open($zipPath) !== true) {
            throw new \RuntimeException("Failed to open ZIP: {$zipPath}");
        }

        $readJson = static function (string $name) use ($zip): mixed {
            $content = $zip->getFromName($name);
            if ($content === false) {
                return null;
            }
            return json_decode($content, true);
        };

        $manifest = $readJson('manifest.json');
        if (!is_array($manifest)) {
            $zip->close();
            throw new \RuntimeException('Invalid or missing manifest.json');
        }

        $types = self::asListOfArrays($readJson('meta/types.json'));
        $attributes = self::asListOfArrays($readJson('meta/attributes.json'));
        $links = self::asListOfArrays($readJson('meta/links.json'));

        $predicatesRaw = $readJson('meta/predicates.json');
        $predicatesData = is_array($predicatesRaw) ? $predicatesRaw : [];
        $predicates = self::asListOfArrays($predicatesData['predicates'] ?? []);
        $predicateRules = self::asListOfArrays($predicatesData['rules'] ?? []);

        // Load note map (uuid → path) for link rewriting on import
        $noteMap = self::asStringMap($readJson('notes/map.json'));
        // Invert: path → uuid
        $pathToId = array_flip($noteMap);

        // Build type key → id lookup from types
        $typeKeyToId = [];
        foreach ($types as $t) {
            $id = $t['id'] ?? null;
            $key = $t['key'] ?? null;
            if (is_string($id) && is_string($key)) {
                $typeKeyToId[$key] = $id;
            }
        }

        // Build attribute name → id lookup (per type)
        $attrNameToId = [];
        foreach ($attributes as $a) {
            $id = $a['id'] ?? null;
            $typeId = $a['type_id'] ?? null;
            $name = $a['name'] ?? null;
            if (is_string($id) && is_string($typeId) && is_string($name)) {
                $attrNameToId[$typeId][$name] = $id;
            }
        }

        // Build file path → note uuid map for image rewriting on import
        $fileNoteIds = self::asStringMap($readJson('files/map.json'));
        // Fallback: scan files/ entries if no map exists (legacy format)
        if ($fileNoteIds === []) {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = $zip->getNameIndex($i);
                if ($name === false) {
                    continue;
                }
                if (str_starts_with($name, 'files/') && !str_ends_with($name, '/') && $name !== 'files/map.json') {
                    $parts = explode('/', $name, 3);
                    if (count($parts) >= 3 && $parts[1] !== '') {
                        $fileNoteIds[$name] = $parts[1];
                    }
                }
            }
        }

        // Collect notes — prefer .md with frontmatter, fall back to .json
        $notes = [];
        $seenIds = [];

        // First: parse .md files using map.json
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if ($name === false) {
                continue;
            }
            if (
                str_starts_with($name, 'notes/') && str_ends_with($name, '.md')
                && !str_ends_with($name, '/_index.md') && $name !== 'notes/index.md' && $name !== 'notes/unlinked.md'
            ) {
                $raw = $zip->getFromIndex($i);
                if ($raw === false) {
                    continue;
                }
                $parsed = self::parseMdNote($raw, $name, $pathToId, $noteMap, $types, $attrNameToId, $fileNoteIds);
                if ($parsed !== null && is_string($parsed['id'] ?? null)) {
                    $notes[] = $parsed;
                    $seenIds[$parsed['id']] = true;
                }
            }
        }

        // Fallback: .json files for notes not found via .md
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if ($name === false) {
                continue;
            }
            if (str_starts_with($name, 'notes/') && str_ends_with($name, '.json') && $name !== 'notes/map.json') {
                $raw = $zip->getFromIndex($i);
                if ($raw === false) {
                    continue;
                }
                $noteData = json_decode($raw, true);
                if (is_array($noteData) && isset($noteData['id']) && is_string($noteData['id']) && !isset($seenIds[$noteData['id']])) {
                    /** @var array<string, mixed> $noteData */
                    $notes[] = $noteData;
                }
            }
        }

        $zip->close();

        $nookMeta = Row::stringKeyed($manifest['nook'] ?? null);

        return [
            'version' => is_int($manifest['version'] ?? null) ? $manifest['version'] : 0,
            'nook' => $nookMeta,
            'types' => $types,
            'attributes' => $attributes,
            'notes' => $notes,
            'predicates' => $predicates,
            'predicate_rules' => $predicateRules,
            'links' => $links,
        ];
    }

    /**
     * Import parsed data into a target nook, upserting all content.
     *
     * @param array<string, mixed> $data  Parsed export data
     * @param string               $targetNookId  Nook to import into
     * @param string               $createdBy     User ID for created_by fields
     */
    public static function importIntoNook(PDO $pdo, array $data, string $targetNookId, string $createdBy): void
    {
        $types = self::asListOfArrays($data['types'] ?? []);
        $attributes = self::asListOfArrays($data['attributes'] ?? []);
        $notes = self::asListOfArrays($data['notes'] ?? []);
        $predicates = self::asListOfArrays($data['predicates'] ?? []);
        $predicateRules = self::asListOfArrays($data['predicate_rules'] ?? []);
        $links = self::asListOfArrays($data['links'] ?? []);

        $pdo->beginTransaction();
        try {
            self::importTypes($pdo, $types, $targetNookId);
            self::importAttributes($pdo, $attributes, $targetNookId);
            self::importNotes($pdo, $notes, $targetNookId, $createdBy);
            self::importPredicates($pdo, $predicates, $targetNookId);
            self::importPredicateRules($pdo, $predicateRules);
            self::importLinks($pdo, $links, $targetNookId);
            self::cleanupRemoved($pdo, [
                'types' => $types,
                'attributes' => $attributes,
                'notes' => $notes,
                'predicates' => $predicates,
                'links' => $links,
            ], $targetNookId);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * @param list<array<string, mixed>> $types
     */
    private static function importTypes(PDO $pdo, array $types, string $nookId): void
    {
        $stmt = $pdo->prepare('
            insert into global.note_types (id, nook_id, key, label, description, parent_id, attribute_layout, config_overrides)
            values (:id, :nook_id, :key, :label, :description, :parent_id, :layout, :overrides)
            on conflict (id) do update set
                key = excluded.key,
                label = excluded.label,
                description = excluded.description,
                parent_id = excluded.parent_id,
                attribute_layout = excluded.attribute_layout,
                config_overrides = excluded.config_overrides,
                updated_at = now()
        ');

        // Sort: parents before children
        usort($types, static function ($a, $b) {
            return !empty($a['parent_id']) <=> !empty($b['parent_id']);
        });

        foreach ($types as $t) {
            $stmt->execute([
                ':id' => $t['id'],
                ':nook_id' => $nookId,
                ':key' => $t['key'],
                ':label' => $t['label'],
                ':description' => $t['description'] ?? '',
                ':parent_id' => $t['parent_id'] ?: null,
                ':layout' => isset($t['attribute_layout']) ? json_encode($t['attribute_layout']) : null,
                ':overrides' => json_encode($t['config_overrides'] ?? new \stdClass()),
            ]);
        }
    }

    /**
     * @param list<array<string, mixed>> $attrs
     */
    private static function importAttributes(PDO $pdo, array $attrs, string $nookId): void
    {
        $stmt = $pdo->prepare('
            insert into global.type_attributes (id, nook_id, type_id, key, name, kind, config, indexed)
            values (:id, :nook_id, :type_id, :key, :name, :kind, :config, :indexed)
            on conflict (id) do update set
                key = excluded.key,
                name = excluded.name,
                kind = excluded.kind,
                config = excluded.config,
                indexed = excluded.indexed,
                updated_at = now()
        ');

        foreach ($attrs as $a) {
            $stmt->execute([
                ':id' => $a['id'],
                ':nook_id' => $nookId,
                ':type_id' => $a['type_id'],
                ':key' => $a['key'],
                ':name' => $a['name'],
                ':kind' => $a['kind'],
                ':config' => json_encode($a['config'] ?? new \stdClass()),
                ':indexed' => $a['indexed'] ? 'true' : 'false',
            ]);
        }
    }

    /**
     * @param list<array<string, mixed>> $notes
     */
    private static function importNotes(PDO $pdo, array $notes, string $nookId, string $createdBy): void
    {
        $stmt = $pdo->prepare('
            insert into global.notes (id, nook_id, created_by, title, content, type_id, attributes)
            values (:id, :nook_id, :created_by, :title, :content, :type_id, :attributes)
            on conflict (id) do update set
                title = excluded.title,
                content = excluded.content,
                type_id = excluded.type_id,
                attributes = excluded.attributes,
                updated_at = now()
        ');

        foreach ($notes as $n) {
            $stmt->execute([
                ':id' => $n['id'],
                ':nook_id' => $nookId,
                ':created_by' => $createdBy,
                ':title' => $n['title'],
                ':content' => $n['content'] ?? '',
                ':type_id' => $n['type_id'] ?: null,
                ':attributes' => json_encode($n['attributes'] ?? new \stdClass()),
            ]);
        }
    }

    /**
     * @param list<array<string, mixed>> $predicates
     */
    private static function importPredicates(PDO $pdo, array $predicates, string $nookId): void
    {
        $stmt = $pdo->prepare('
            insert into global.link_predicates (id, nook_id, key, forward_label, reverse_label, supports_start_date, supports_end_date)
            values (:id, :nook_id, :key, :forward, :reverse, :start, :end)
            on conflict (id) do update set
                key = excluded.key,
                forward_label = excluded.forward_label,
                reverse_label = excluded.reverse_label,
                supports_start_date = excluded.supports_start_date,
                supports_end_date = excluded.supports_end_date,
                updated_at = now()
        ');

        foreach ($predicates as $p) {
            $stmt->execute([
                ':id' => $p['id'],
                ':nook_id' => $nookId,
                ':key' => $p['key'],
                ':forward' => $p['forward_label'],
                ':reverse' => $p['reverse_label'],
                ':start' => ($p['supports_start_date'] ?? false) ? 'true' : 'false',
                ':end' => ($p['supports_end_date'] ?? false) ? 'true' : 'false',
            ]);
        }
    }

    /**
     * @param list<array<string, mixed>> $rules
     */
    private static function importPredicateRules(PDO $pdo, array $rules): void
    {
        foreach ($rules as $r) {
            $pdo->prepare('
                insert into global.link_predicate_rules (predicate_id, source_type_id, target_type_id, include_source_subtypes, include_target_subtypes)
                values (:pred, :src, :tgt, :src_sub, :tgt_sub)
                on conflict (predicate_id, source_type_id, target_type_id) do update set
                    include_source_subtypes = excluded.include_source_subtypes,
                    include_target_subtypes = excluded.include_target_subtypes
            ')->execute([
                ':pred' => $r['predicate_id'],
                ':src' => $r['source_type_id'] ?: null,
                ':tgt' => $r['target_type_id'] ?: null,
                ':src_sub' => ($r['include_source_subtypes'] ?? true) ? 'true' : 'false',
                ':tgt_sub' => ($r['include_target_subtypes'] ?? true) ? 'true' : 'false',
            ]);
        }
    }

    /**
     * @param list<array<string, mixed>> $links
     */
    private static function importLinks(PDO $pdo, array $links, string $nookId): void
    {
        $stmt = $pdo->prepare('
            insert into global.note_links (id, nook_id, predicate_id, source_note_id, target_note_id, start_date, end_date)
            values (:id, :nook_id, :pred, :src, :tgt, :start, :end)
            on conflict (id) do update set
                predicate_id = excluded.predicate_id,
                source_note_id = excluded.source_note_id,
                target_note_id = excluded.target_note_id,
                start_date = excluded.start_date,
                end_date = excluded.end_date,
                updated_at = now()
        ');

        foreach ($links as $l) {
            $stmt->execute([
                ':id' => $l['id'],
                ':nook_id' => $nookId,
                ':pred' => $l['predicate_id'],
                ':src' => $l['source_note_id'],
                ':tgt' => $l['target_note_id'],
                ':start' => $l['start_date'] ?? null,
                ':end' => $l['end_date'] ?? null,
            ]);
        }
    }

    /**
     * Remove entities that exist in the DB but not in the export (deleted in source).
     *
     * @param array{types?: list<array<string, mixed>>, attributes?: list<array<string, mixed>>, notes?: list<array<string, mixed>>, predicates?: list<array<string, mixed>>, links?: list<array<string, mixed>>} $data
     */
    private static function cleanupRemoved(PDO $pdo, array $data, string $nookId): void
    {
        /** @param list<array<string, mixed>> $items */
        $cleanup = static function (string $table, string $idColumn, array $items) use ($pdo, $nookId): void {
            $ids = array_column($items, 'id');
            if ($ids === []) {
                $pdo->prepare("delete from global.{$table} where nook_id = :nook_id")
                    ->execute([':nook_id' => $nookId]);
                return;
            }
            $placeholders = implode(',', array_map(fn($i) => ":id{$i}", range(0, count($ids) - 1)));
            $params = [':nook_id' => $nookId];
            foreach ($ids as $i => $id) {
                $params[":id{$i}"] = $id;
            }
            $pdo->prepare("delete from global.{$table} where nook_id = :nook_id and {$idColumn} not in ({$placeholders})")
                ->execute($params);
        };

        // Order matters: links before predicates, notes before types
        $cleanup('note_links', 'id', $data['links'] ?? []);
        $cleanup('notes', 'id', $data['notes'] ?? []);
        $cleanup('type_attributes', 'id', $data['attributes'] ?? []);
        $cleanup('note_types', 'id', $data['types'] ?? []);
        $cleanup('link_predicates', 'id', $data['predicates'] ?? []);
    }

    // ── Parse .md note with frontmatter ─────────────────────────────────────────

    /**
     * Parse a markdown file with YAML frontmatter back into a note data array.
     *
     * @param array<string, string> $pathToId   path → uuid
     * @param array<string, string>                $pathToId
     * @param array<string, string>                $noteMap    uuid → path (for rewriting links back)
     * @param list<array<string, mixed>>           $types
     * @param array<string, array<string, string>> $attrNameToId  type_id → { name → attr_id }
     * @param array<string, string>                $fileNoteIds
     * @return array<string, mixed>|null
     */
    private static function parseMdNote(
        string $raw,
        string $zipEntryName,
        array $pathToId,
        array $noteMap,
        array $types,
        array $attrNameToId,
        array $fileNoteIds = [],
    ): ?array {
        // Extract frontmatter
        if (!str_starts_with($raw, "---\n")) {
            return null;
        }
        $endPos = strpos($raw, "\n---\n", 4);
        if ($endPos === false) {
            return null;
        }

        $fmRaw = substr($raw, 4, $endPos - 4);
        $body = substr($raw, $endPos + 5);

        // Extract content from between <!-- paith:content --> markers
        $content = self::extractContent($body);

        // Simple YAML parsing
        $fm = self::parseSimpleYaml($fmRaw);
        $rawId = $fm['id'] ?? null;
        if (!is_string($rawId) || $rawId === '') {
            return null;
        }
        $noteId = $rawId;

        // Resolve type label → type_id
        $typeId = null;
        if (isset($fm['type']) && is_string($fm['type'])) {
            $wantedLabel = $fm['type'];
            foreach ($types as $t) {
                $label = is_string($t['label'] ?? null) ? $t['label'] : '';
                if ($label === $wantedLabel) {
                    $candidate = $t['id'] ?? null;
                    if (is_string($candidate)) {
                        $typeId = $candidate;
                    }
                    break;
                }
            }
        }

        // Resolve frontmatter attributes (name → uuid)
        $attributes = [];
        if (is_array($fm['attributes'] ?? null) && $typeId !== null && isset($attrNameToId[$typeId])) {
            $nameMap = $attrNameToId[$typeId];
            foreach ($fm['attributes'] as $name => $value) {
                if (is_string($name) && isset($nameMap[$name])) {
                    $attributes[$nameMap[$name]] = $value;
                }
            }
        }

        // Rewrite relative links + images back to [[note:uuid]] / ![](note:uuid)
        /** @var array<string, string> $pathToId */
        /** @var array<string, string> $fileNoteIds */
        $content = Export\NoteLinker::rewriteToInternal($content, $zipEntryName, $pathToId, $fileNoteIds);

        return [
            'id' => $noteId,
            'title' => $fm['title'] ?? basename($zipEntryName, '.md'),
            'content' => $content,
            'type_id' => $typeId,
            'attributes' => $attributes ?: new \stdClass(),
        ];
    }

    /**
     * Extract content from between <!-- paith:content --> markers.
     * Falls back to full body if markers are absent (legacy or hand-edited).
     */
    private static function extractContent(string $body): string
    {
        $startMarker = '<!-- paith:content -->';
        $endMarker = '<!-- /paith:content -->';

        $startPos = strpos($body, $startMarker);
        if ($startPos === false) {
            return trim($body);
        }

        $contentStart = $startPos + strlen($startMarker);
        $endPos = strpos($body, $endMarker, $contentStart);
        if ($endPos === false) {
            return trim(substr($body, $contentStart));
        }

        return trim(substr($body, $contentStart, $endPos - $contentStart));
    }

    /**
     * Minimal YAML parser for frontmatter — handles flat keys, nested maps, and lists.
     *
     * @return array<string, mixed>
     */
    private static function parseSimpleYaml(string $yaml): array
    {
        $result = [];
        $lines = explode("\n", $yaml);
        $currentKey = '';
        $currentIndent = 0;
        $subMap = [];
        $subList = [];
        $inList = false;
        $inMap = false;

        foreach ($lines as $line) {
            if (trim($line) === '') {
                continue;
            }

            $stripped = ltrim($line);
            $indent = strlen($line) - strlen($stripped);

            // Top-level key
            if ($indent === 0 && preg_match('/^([^:]+):\s*(.*)$/', $stripped, $m)) {
                // Flush previous sub-structure
                if ($inMap && $currentKey !== '') {
                    $result[$currentKey] = $subMap;
                } elseif ($inList && $currentKey !== '') {
                    $result[$currentKey] = $subList;
                }
                $inMap = false;
                $inList = false;
                $subMap = [];
                $subList = [];

                $currentKey = trim($m[1]);
                $value = trim($m[2]);
                if ($value !== '') {
                    $result[$currentKey] = self::yamlValue($value);
                }
                $currentIndent = 0;
                continue;
            }

            // Nested list item
            if ($indent > 0 && str_starts_with($stripped, '- ')) {
                $inList = true;
                $inMap = false;
                $subList[] = self::yamlValue(trim(substr($stripped, 2)));
                continue;
            }

            // Nested map key
            if ($indent > 0 && preg_match('/^([^:]+):\s*(.*)$/', $stripped, $m)) {
                $inMap = true;
                $inList = false;
                $subKey = trim($m[1]);
                $subVal = trim($m[2]);
                if ($subVal !== '') {
                    $subMap[$subKey] = self::yamlValue($subVal);
                }
                continue;
            }
        }

        // Flush last
        if ($inMap && $currentKey !== '') {
            $result[$currentKey] = $subMap;
        } elseif ($inList && $currentKey !== '') {
            $result[$currentKey] = $subList;
        }

        return $result;
    }

    private static function yamlValue(string $raw): mixed
    {
        if ($raw === 'null') {
            return null;
        }
        if ($raw === 'true' || $raw === 'yes') {
            return true;
        }
        if ($raw === 'false' || $raw === 'no') {
            return false;
        }
        if (is_numeric($raw) && !str_starts_with($raw, '0') || $raw === '0') {
            return str_contains($raw, '.') ? (float) $raw : (int) $raw;
        }
        // Inline list: [a, b, c]
        if (str_starts_with($raw, '[') && str_ends_with($raw, ']')) {
            $inner = substr($raw, 1, -1);
            return array_map(fn($s) => self::yamlValue(trim($s)), explode(',', $inner));
        }
        // Strip quotes
        if (
            (str_starts_with($raw, '"') && str_ends_with($raw, '"'))
            || (str_starts_with($raw, "'") && str_ends_with($raw, "'"))
        ) {
            return stripcslashes(substr($raw, 1, -1));
        }
        return $raw;
    }

    /**
     * Import a zip as a brand-new nook with freshly generated UUIDs for every
     * entity. Use this for user-facing "import from zip" — preserving the
     * source IDs would risk overwriting unrelated nooks' rows in the shared
     * global.* tables.
     *
     * Returns the new nook id.
     */
    public static function importAsNewNook(
        PDO $pdo,
        string $zipPath,
        string $ownerId,
        ?string $nookName = null,
    ): string {
        $data = self::parseZip($zipPath);
        [$remapped] = Import\RemapIds::remap($data);

        $sourceName = is_string($data['nook']['name'] ?? null)
            ? $data['nook']['name']
            : 'Imported nook';
        $name = $nookName !== null && trim($nookName) !== ''
            ? trim($nookName)
            : $sourceName;

        $pdo->beginTransaction();
        try {
            $create = $pdo->prepare(
                "insert into global.nooks (name, created_by, owner_id, purpose) "
                . "values (:name, :created_by, :owner_id, 'general') returning id"
            );
            $create->execute([
                ':name' => $name,
                ':created_by' => $ownerId,
                ':owner_id' => $ownerId,
            ]);
            $nookId = (string) $create->fetchColumn();

            $pdo->prepare(
                "insert into global.nook_members (nook_id, user_id, role) "
                . "values (:nook_id, :user_id, 'owner') "
                . "on conflict (nook_id, user_id) do nothing"
            )->execute([':nook_id' => $nookId, ':user_id' => $ownerId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        self::importIntoNook($pdo, $remapped, $nookId, $ownerId);
        return $nookId;
    }

    /**
     * Seed or update the handbook nook from a ZIP file.
     * Returns the handbook nook ID, or null if no file exists.
     */
    public static function seedHandbook(PDO $pdo, string $zipPath): ?string
    {
        if (!file_exists($zipPath)) {
            return null;
        }

        $data = self::parseZip($zipPath);
        $exportVersion = $data['version'];
        if ($exportVersion < 1) {
            return null;
        }

        // Check if handbook nook already exists
        $check = $pdo->prepare("select id from global.nooks where purpose = 'handbook' limit 1");
        $check->execute();
        $nookId = $check->fetchColumn();

        if ($nookId) {
            // Check stored version — skip if already up to date
            $verCheck = $pdo->prepare("select (settings->>'handbook_version')::int from global.user_nook_preferences where nook_id = :nook_id and user_id = :user_id limit 1");
            $verCheck->execute([':nook_id' => $nookId, ':user_id' => self::AI_USER_ID]);
            $storedVersion = (int) ($verCheck->fetchColumn() ?: 0);
            if ($storedVersion >= $exportVersion) {
                return (string) $nookId;
            }
        } else {
            // Create the handbook nook
            $nookName = $data['nook']['name'] ?? 'Handbook';
            $create = $pdo->prepare("
                insert into global.nooks (name, created_by, owner_id, purpose)
                values (:name, :owner, :owner, 'handbook')
                returning id
            ");
            $create->execute([':name' => $nookName, ':owner' => self::AI_USER_ID]);
            $nookId = $create->fetchColumn();

            // System user is owner
            $pdo->prepare("
                insert into global.nook_members (nook_id, user_id, role)
                values (:nook_id, :user_id, 'owner')
                on conflict (nook_id, user_id) do nothing
            ")->execute([':nook_id' => $nookId, ':user_id' => self::AI_USER_ID]);
        }

        // Import content
        self::importIntoNook($pdo, $data, (string) $nookId, self::AI_USER_ID);

        // Store version
        $pdo->prepare("
            insert into global.user_nook_preferences (user_id, nook_id, settings)
            values (:user_id, :nook_id, :settings)
            on conflict (user_id, nook_id) do update set settings = global.user_nook_preferences.settings || excluded.settings
        ")->execute([
            ':user_id' => self::AI_USER_ID,
            ':nook_id' => $nookId,
            ':settings' => json_encode(['handbook_version' => $exportVersion]),
        ]);

        return (string) $nookId;
    }

    /**
     * Ensure a user has readonly membership in the handbook nook.
     */
    public static function ensureHandbookMember(PDO $pdo, string $userId): ?string
    {
        $check = $pdo->prepare("select id from global.nooks where purpose = 'handbook' limit 1");
        $check->execute();
        $nookId = $check->fetchColumn();
        if (!$nookId) {
            return null;
        }

        $pdo->prepare("
            insert into global.nook_members (nook_id, user_id, role)
            values (:nook_id, :user_id, 'readonly')
            on conflict (nook_id, user_id) do nothing
        ")->execute([':nook_id' => $nookId, ':user_id' => $userId]);

        return (string) $nookId;
    }

    /**
     * Narrow a JSON-decoded value to a list of associative arrays.
     *
     * @return list<array<string, mixed>>
     */
    private static function asListOfArrays(mixed $value): array
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

    /**
     * Narrow a JSON-decoded value to a string→string map.
     * Keeps only pairs where both key and value are strings.
     *
     * @return array<string, string>
     */
    private static function asStringMap(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $k => $v) {
            if (is_string($k) && is_string($v)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }
}
