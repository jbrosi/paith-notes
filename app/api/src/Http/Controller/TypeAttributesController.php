<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Service\AttributeValidator;
use PDO;
use Throwable;

final class TypeAttributesController
{
    private const VALID_KINDS = ['text', 'number', 'boolean', 'date', 'date_range', 'select', 'multi_select', 'url', 'file', 'graph', 'view', 'linked_notes', 'mentions', 'history', 'toc', 'metadata', 'content', 'source'];

    /**
     * List all attributes for a type, including inherited attributes from ancestors.
     */
    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $typeId = self::requireUuid($request->routeParam('typeId'), 'typeId');

        $this->requireMember($pdo, $user, $nookId);
        $this->requireType($pdo, $nookId, $typeId);

        $attributes = $this->resolveInheritedAttributes($pdo, $nookId, $typeId);

        return JsonResponse::ok(['attributes' => $attributes]);
    }

    /**
     * Create a new attribute on a type.
     */
    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $typeId = self::requireUuid($request->routeParam('typeId'), 'typeId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->requireType($pdo, $nookId, $typeId);

        $data = $request->jsonBody();

        $name = self::requireString($data, 'name');
        $kind = self::requireString($data, 'kind');
        if (!in_array($kind, self::VALID_KINDS, true)) {
            throw new HttpError('kind must be one of: ' . implode(', ', self::VALID_KINDS), 400);
        }

        $config = self::optionalJsonObject($data, 'config');
        $this->validateConfig($kind, $config);

        $indexed = isset($data['indexed']) && $data['indexed'] === true;

        // Key: user-provided or auto-slugified from name
        $keyRaw = $data['key'] ?? null;
        $key = is_string($keyRaw) && trim($keyRaw) !== '' ? self::slugify($keyRaw) : self::slugify($name);

        // Validate name uniqueness within resolved attribute set (own + inherited)
        $existing = $this->resolveInheritedAttributes($pdo, $nookId, $typeId);
        foreach ($existing as $attr) {
            if (strcasecmp($attr['name'], $name) === 0) {
                throw new HttpError('attribute name "' . $name . '" already exists (own or inherited)', 409);
            }
        }

        // Also check descendant types for name conflicts
        $this->checkDescendantNameConflict($pdo, $nookId, $typeId, $name, '');

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'insert into global.type_attributes (nook_id, type_id, name, key, kind, config, indexed) '
                . 'values (:nook_id, :type_id, :name, :key, :kind, :config::jsonb, :indexed) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':name', $name);
            $stmt->bindValue(':key', $key);
            $stmt->bindValue(':kind', $kind);
            $stmt->bindValue(':config', json_encode($config));
            $stmt->bindValue(':indexed', $indexed, PDO::PARAM_BOOL);
            $stmt->execute();

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create attribute', 500);
            }

            $pdo->commit();

            $id = is_scalar($row['id'] ?? null) ? (string)$row['id'] : '';

            // Index lifecycle: create after commit (outside transaction for safety)
            $this->syncAttributeIndex($pdo, $id, $kind, $indexed);

            return JsonResponse::ok([
                'attribute' => [
                    'id' => $id,
                    'type_id' => $typeId,
                    'name' => $name,
                    'key' => $key,
                    'kind' => $kind,
                    'config' => $config === [] ? (object)[] : $config,
                    'indexed' => $indexed,
                    'inherited' => false,
                    'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                    'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Update an attribute.
     */
    public function update(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $typeId = self::requireUuid($request->routeParam('typeId'), 'typeId');
        $attrId = self::requireUuid($request->routeParam('attributeId'), 'attributeId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->requireType($pdo, $nookId, $typeId);

        // Verify attribute belongs to this type (not inherited)
        $check = $pdo->prepare('select id from global.type_attributes where id = :id and type_id = :type_id and nook_id = :nook_id');
        $check->execute([':id' => $attrId, ':type_id' => $typeId, ':nook_id' => $nookId]);
        if (!$check->fetchColumn()) {
            throw new HttpError('attribute not found on this type (inherited attributes cannot be edited here)', 404);
        }

        $data = $request->jsonBody();

        $name = self::requireString($data, 'name');
        $kind = self::requireString($data, 'kind');
        if (!in_array($kind, self::VALID_KINDS, true)) {
            throw new HttpError('kind must be one of: ' . implode(', ', self::VALID_KINDS), 400);
        }

        $config = self::optionalJsonObject($data, 'config');
        $this->validateConfig($kind, $config);

        $indexed = isset($data['indexed']) && $data['indexed'] === true;

        $keyRaw = $data['key'] ?? null;
        $key = is_string($keyRaw) && trim($keyRaw) !== '' ? self::slugify($keyRaw) : null;

        // Validate name uniqueness (excluding self)
        $existing = $this->resolveInheritedAttributes($pdo, $nookId, $typeId);
        foreach ($existing as $attr) {
            if ($attr['id'] !== $attrId && strcasecmp($attr['name'], $name) === 0) {
                throw new HttpError('attribute name "' . $name . '" already exists (own or inherited)', 409);
            }
        }

        $this->checkDescendantNameConflict($pdo, $nookId, $typeId, $name, $attrId);

        $sql = 'update global.type_attributes set name = :name, kind = :kind, config = :config::jsonb, '
            . 'indexed = :indexed';
        if ($key !== null) {
            $sql .= ', key = :key';
        }
        $sql .= ', updated_at = now() '
            . 'where id = :id and type_id = :type_id and nook_id = :nook_id '
            . 'returning key, created_at, updated_at';

        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':id', $attrId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':name', $name);
        $stmt->bindValue(':kind', $kind);
        $stmt->bindValue(':config', json_encode($config));
        $stmt->bindValue(':indexed', $indexed, PDO::PARAM_BOOL);
        if ($key !== null) {
            $stmt->bindValue(':key', $key);
        }
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('attribute not found', 404);
        }

        $resolvedKey = is_scalar($row['key'] ?? null) ? (string)$row['key'] : ($key ?? '');

        // Index lifecycle: re-sync (kind or indexed flag may have changed)
        $this->syncAttributeIndex($pdo, $attrId, $kind, $indexed);

        return JsonResponse::ok([
            'attribute' => [
                'id' => $attrId,
                'type_id' => $typeId,
                'name' => $name,
                'key' => $resolvedKey,
                'kind' => $kind,
                'config' => $config === [] ? (object)[] : $config,
                'indexed' => $indexed,
                'inherited' => false,
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
            ],
        ]);
    }

    /**
     * Delete an attribute.
     */
    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $typeId = self::requireUuid($request->routeParam('typeId'), 'typeId');
        $attrId = self::requireUuid($request->routeParam('attributeId'), 'attributeId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->requireType($pdo, $nookId, $typeId);

        $stmt = $pdo->prepare(
            'delete from global.type_attributes where id = :id and type_id = :type_id and nook_id = :nook_id returning id'
        );
        $stmt->execute([':id' => $attrId, ':type_id' => $typeId, ':nook_id' => $nookId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('attribute not found on this type', 404);
        }

        // Drop any expression index for this attribute
        $this->dropAttributeIndex($pdo, $attrId);

        return JsonResponse::ok([
            'deleted' => true,
            'attribute_id' => $attrId,
        ]);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Resolve all attributes visible to a type: own + inherited from ancestors.
     * Applies config_overrides (shallow merge) and filters hidden attributes.
     * Resolves attribute_layout with inheritance (null = inherit parent layout).
     * @return array<int, array<string, mixed>>
     */
    private function resolveInheritedAttributes(PDO $pdo, string $nookId, string $typeId): array
    {
        $stmt = $pdo->prepare(
            'with recursive type_tree as (
                select id from global.note_types where id = :type_id and nook_id = :nook_id
                union all
                select t.parent_id from global.note_types t
                join type_tree tt on t.id = tt.id
                where t.parent_id is not null
            )
            select ta.id, ta.type_id, ta.name, ta.key, ta.kind, ta.config, ta.indexed, ta.created_at, ta.updated_at
            from global.type_attributes ta
            join type_tree tt on ta.type_id = tt.id'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->execute();

        // Load config_overrides for this type
        $overridesStmt = $pdo->prepare('select config_overrides from global.note_types where id = :id and nook_id = :nook_id');
        $overridesStmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $overridesRaw = $overridesStmt->fetchColumn();
        $overrides = [];
        if (is_scalar($overridesRaw)) {
            $decoded = json_decode((string)$overridesRaw, true);
            if (is_array($decoded)) {
                $overrides = $decoded;
            }
        }

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $out = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $attrId = is_scalar($r['id'] ?? null) ? (string)$r['id'] : '';
            $inherited = (string)($r['type_id'] ?? '') !== $typeId;
            $config = self::decodeJsonObject($r['config'] ?? null);

            // Apply config overrides for inherited attributes
            $overridden = false;
            if ($inherited && isset($overrides[$attrId]) && is_array($overrides[$attrId])) {
                $attrOverride = $overrides[$attrId];

                // "hidden": true means this type hides the inherited attribute
                if (!empty($attrOverride['hidden'])) {
                    continue;
                }

                // Shallow merge: override keys win
                $config = array_merge($config, $attrOverride);
                $overridden = true;
            }

            $out[] = [
                'id' => $attrId,
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
                'name' => is_scalar($r['name'] ?? null) ? (string)$r['name'] : '',
                'key' => is_scalar($r['key'] ?? null) ? (string)$r['key'] : '',
                'kind' => is_scalar($r['kind'] ?? null) ? (string)$r['kind'] : '',
                'config' => $config === [] ? (object)[] : $config,
                'indexed' => (bool)($r['indexed'] ?? false),
                'inherited' => $inherited,
                'overridden' => $overridden,
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
            ];
        }

        // Resolve attribute layout (panel-based ordering) with inheritance
        $layout = $this->resolveAttributeLayout($pdo, $nookId, $typeId);
        $order = $this->flattenLayoutOrder($layout);

        if ($order !== []) {
            $posMap = array_flip($order);
            usort($out, function (array $a, array $b) use ($posMap): int {
                $pa = $posMap[$a['id']] ?? PHP_INT_MAX;
                $pb = $posMap[$b['id']] ?? PHP_INT_MAX;
                if ($pa !== $pb) return $pa <=> $pb;
                return strcasecmp($a['name'], $b['name']);
            });
        } else {
            usort($out, fn(array $a, array $b) => strcasecmp($a['name'], $b['name']));
        }

        return $out;
    }

    /**
     * Resolve attribute layout for a type with inheritance.
     * Walks parent chain, merges panels by key (child overrides parent).
     * @return array{panels: list<array{key: string, position: string, attributes: list<string>}>}
     */
    private function resolveAttributeLayout(PDO $pdo, string $nookId, string $typeId): array
    {
        $stmt = $pdo->prepare(
            'select attribute_layout, parent_id from global.note_types where id = :id and nook_id = :nook_id'
        );
        $stmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return ['panels' => []];
        }

        $ownLayout = null;
        if (is_scalar($row['attribute_layout'] ?? null)) {
            $decoded = json_decode((string)$row['attribute_layout'], true);
            if (is_array($decoded) && isset($decoded['panels']) && is_array($decoded['panels'])) {
                $ownLayout = $decoded;
            }
        }

        $parentId = is_scalar($row['parent_id'] ?? null) ? (string)$row['parent_id'] : '';

        // No parent — own layout is final
        if ($parentId === '') {
            return $ownLayout ?? ['panels' => []];
        }

        // Get parent's resolved layout (recursive)
        $parentLayout = $this->resolveAttributeLayout($pdo, $nookId, $parentId);

        // No own layout — inherit parent
        if ($ownLayout === null) {
            return $parentLayout;
        }

        // Merge: child panels override parent panels by key
        $merged = [];
        foreach ($parentLayout['panels'] ?? [] as $p) {
            if (is_array($p) && is_string($p['key'] ?? null)) {
                $merged[$p['key']] = $p;
            }
        }
        foreach ($ownLayout['panels'] ?? [] as $p) {
            if (!is_array($p) || !is_string($p['key'] ?? null)) continue;
            $key = $p['key'];
            if (isset($merged[$key])) {
                // Shallow merge: child fields override parent fields
                $merged[$key] = array_merge($merged[$key], $p);
            } else {
                $merged[$key] = $p;
            }
        }

        // Filter out hidden panels
        $panels = [];
        foreach ($merged as $p) {
            if (!empty($p['hidden'])) continue;
            $panels[] = $p;
        }

        return ['panels' => array_values($panels)];
    }

    /**
     * Flatten a resolved layout into a single ordered list of attribute IDs.
     * Main panel first, then side panels in order.
     * @return string[]
     */
    private function flattenLayoutOrder(array $layout): array
    {
        $panels = $layout['panels'] ?? [];
        if (!is_array($panels) || $panels === []) {
            return [];
        }

        $order = [];
        // Main panel first
        foreach ($panels as $p) {
            if (is_array($p) && ($p['position'] ?? '') === 'main') {
                foreach ($p['attributes'] ?? [] as $id) {
                    if (is_string($id)) $order[] = $id;
                }
            }
        }
        // Then side panels
        foreach ($panels as $p) {
            if (is_array($p) && ($p['position'] ?? '') !== 'main') {
                foreach ($p['attributes'] ?? [] as $id) {
                    if (is_string($id)) $order[] = $id;
                }
            }
        }
        return $order;
    }

    /**
     * Check that no descendant type already has an attribute with the given name.
     */
    private function checkDescendantNameConflict(PDO $pdo, string $nookId, string $typeId, string $name, string $excludeAttrId): void
    {
        $stmt = $pdo->prepare(
            'with recursive descendants as (
                select id from global.note_types where parent_id = :type_id and nook_id = :nook_id
                union all
                select t.id from global.note_types t
                join descendants d on t.parent_id = d.id
                where t.nook_id = :nook_id
            )
            select ta.id from global.type_attributes ta
            join descendants d on ta.type_id = d.id
            where lower(ta.name) = lower(:name)
            limit 1'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':name', $name);
        $stmt->execute();
        $conflictId = $stmt->fetchColumn();
        if ($conflictId !== false && (string)$conflictId !== $excludeAttrId) {
            throw new HttpError('attribute name "' . $name . '" conflicts with a descendant type attribute', 409);
        }
    }

    /**
     * Create or drop an expression index on notes.attributes for the given attribute.
     * Index name is deterministic: idx_notes_attr_<first 12 chars of uuid>.
     */
    private function syncAttributeIndex(PDO $pdo, string $attrId, string $kind, bool $indexed): void
    {
        // Sanitize: only hex + hyphens from UUID, take a short prefix for the index name
        $short = str_replace('-', '', substr($attrId, 0, 12));
        $idxName = 'idx_notes_attr_' . $short;

        if (!$indexed) {
            $pdo->exec("drop index if exists global.{$idxName}");
            $pdo->exec("drop index if exists global.{$idxName}_from");
            $pdo->exec("drop index if exists global.{$idxName}_to");
            return;
        }

        // Drop any previous indexes for this attribute (kind may have changed)
        $pdo->exec("drop index if exists global.{$idxName}");
        $pdo->exec("drop index if exists global.{$idxName}_from");
        $pdo->exec("drop index if exists global.{$idxName}_to");

        // date_range: two indexes on from/to for overlap queries
        if ($kind === 'date_range') {
            $fromExpr = "(attributes->'{$attrId}'->>'from')::date";
            $toExpr = "(attributes->'{$attrId}'->>'to')::date";
            $fromWhere = "attributes->'{$attrId}'->>'from' IS NOT NULL";
            $toWhere = "attributes->'{$attrId}'->>'to' IS NOT NULL";
            $pdo->exec("create index {$idxName}_from on global.notes (nook_id, {$fromExpr}) where {$fromWhere}");
            $pdo->exec("create index {$idxName}_to on global.notes (nook_id, {$toExpr}) where {$toWhere}");
            return;
        }

        // Single expression index for other kinds
        $expr = match ($kind) {
            'number' => "global.safe_numeric(attributes->>'{$attrId}')",
            'date' => "(attributes->>'{$attrId}')::date",
            'text' => "attributes->>'{$attrId}'",
            'select' => "attributes->>'{$attrId}'",
            default => null,
        };

        if ($expr === null) {
            return;
        }

        $whereClause = "attributes->>'{$attrId}' IS NOT NULL";
        // nook_id included as the primary query scope for all attribute searches.
        $pdo->exec("create index {$idxName} on global.notes (nook_id, {$expr}) where {$whereClause}");
    }

    private function dropAttributeIndex(PDO $pdo, string $attrId): void
    {
        $short = str_replace('-', '', substr($attrId, 0, 12));
        $idxName = 'idx_notes_attr_' . $short;
        $pdo->exec("drop index if exists global.{$idxName}");
        $pdo->exec("drop index if exists global.{$idxName}_from");
        $pdo->exec("drop index if exists global.{$idxName}_to");
    }

    private function validateConfig(string $kind, array $config): void
    {
        AttributeValidator::validateConfig($kind, $config);
    }

    private function requireType(PDO $pdo, string $nookId, string $typeId): void
    {
        $stmt = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
        $stmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        if (!$stmt->fetchColumn()) {
            throw new HttpError('type not found', 404);
        }
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): void
    {
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }
        $check = $pdo->prepare('select 1 from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([':nook_id' => $nookId, ':user_id' => $userId]);
        if (!$check->fetch()) {
            throw new HttpError('forbidden', 403);
        }
    }

    private static function requireUuid(string $value, string $name): string
    {
        $v = trim($value);
        if ($v === '') {
            throw new HttpError($name . ' is required', 400);
        }
        if (!self::isUuid($v)) {
            throw new HttpError($name . ' must be a UUID', 400);
        }
        return $v;
    }

    private static function requireString(array $data, string $key): string
    {
        $raw = $data[$key] ?? '';
        $val = is_string($raw) ? trim($raw) : '';
        if ($val === '') {
            throw new HttpError($key . ' is required', 400);
        }
        return $val;
    }

    /** @return array<string, mixed> */
    private static function optionalJsonObject(array $data, string $key): array
    {
        $raw = $data[$key] ?? [];
        if (is_array($raw)) {
            return $raw;
        }
        return [];
    }

    /** @return array<string, mixed> */
    private static function decodeJsonObject(mixed $value): array
    {
        if (!is_scalar($value)) {
            return [];
        }
        $decoded = json_decode((string)$value, true);
        if (!is_array($decoded)) {
            return [];
        }
        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    private static function slugify(string $value): string
    {
        $slug = strtolower(trim($value));
        $slug = (string)preg_replace('/[^a-z0-9]+/', '-', $slug);
        return trim($slug, '-');
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
