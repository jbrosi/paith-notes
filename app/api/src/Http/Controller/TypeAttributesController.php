<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use Throwable;

final class TypeAttributesController
{
    private const VALID_KINDS = ['text', 'number', 'boolean', 'date', 'date_range', 'select', 'file', 'graph'];

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
                'insert into global.type_attributes (nook_id, type_id, name, kind, config, indexed) '
                . 'values (:nook_id, :type_id, :name, :kind, :config::jsonb, :indexed) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':type_id', $typeId);
            $stmt->bindValue(':name', $name);
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

            return JsonResponse::ok([
                'attribute' => [
                    'id' => $id,
                    'type_id' => $typeId,
                    'name' => $name,
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

        // Validate name uniqueness (excluding self)
        $existing = $this->resolveInheritedAttributes($pdo, $nookId, $typeId);
        foreach ($existing as $attr) {
            if ($attr['id'] !== $attrId && strcasecmp($attr['name'], $name) === 0) {
                throw new HttpError('attribute name "' . $name . '" already exists (own or inherited)', 409);
            }
        }

        $this->checkDescendantNameConflict($pdo, $nookId, $typeId, $name, $attrId);

        $stmt = $pdo->prepare(
            'update global.type_attributes set name = :name, kind = :kind, config = :config::jsonb, '
            . 'indexed = :indexed, updated_at = now() '
            . 'where id = :id and type_id = :type_id and nook_id = :nook_id '
            . 'returning created_at, updated_at'
        );
        $stmt->bindValue(':id', $attrId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':name', $name);
        $stmt->bindValue(':kind', $kind);
        $stmt->bindValue(':config', json_encode($config));
        $stmt->bindValue(':indexed', $indexed, PDO::PARAM_BOOL);
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('attribute not found', 404);
        }

        return JsonResponse::ok([
            'attribute' => [
                'id' => $attrId,
                'type_id' => $typeId,
                'name' => $name,
                'kind' => $kind,
                'config' => $config === [] ? (object)[] : $config,
                'position' => $position,
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

        return JsonResponse::ok([
            'deleted' => true,
            'attribute_id' => $attrId,
        ]);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Resolve all attributes visible to a type: own + inherited from ancestors.
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
            select ta.id, ta.type_id, ta.name, ta.kind, ta.config, ta.indexed, ta.created_at, ta.updated_at
            from global.type_attributes ta
            join type_tree tt on ta.type_id = tt.id'
        );
        $stmt->bindValue(':type_id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->execute();

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $out = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $config = self::decodeJsonObject($r['config'] ?? null);
            $out[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
                'name' => is_scalar($r['name'] ?? null) ? (string)$r['name'] : '',
                'kind' => is_scalar($r['kind'] ?? null) ? (string)$r['kind'] : '',
                'config' => $config === [] ? (object)[] : $config,
                'indexed' => (bool)($r['indexed'] ?? false),
                'inherited' => (string)($r['type_id'] ?? '') !== $typeId,
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
            ];
        }

        // Sort by attribute_order from the type, unordered attributes at end sorted by name
        $orderStmt = $pdo->prepare('select attribute_order from global.note_types where id = :id and nook_id = :nook_id');
        $orderStmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $orderRaw = $orderStmt->fetchColumn();
        $order = [];
        if (is_scalar($orderRaw)) {
            $decoded = json_decode((string)$orderRaw, true);
            if (is_array($decoded)) {
                $order = array_values(array_filter($decoded, 'is_string'));
            }
        }

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

    private function validateConfig(string $kind, array $config): void
    {
        if ($kind === 'select') {
            $options = $config['options'] ?? null;
            if (!is_array($options) || $options === []) {
                throw new HttpError('select kind requires a non-empty "options" array in config', 400);
            }
        }
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

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
