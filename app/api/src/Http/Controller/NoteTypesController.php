<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\Dto\NoteTypeRequest;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Shared\Db\Rows\NoteTypeRow;
use Paith\Notes\Shared\Db\Rows\TypeAttributeRow;
use Paith\Notes\Shared\Uuid;
use PDO;
use Throwable;
use Paith\Notes\Api\Http\Auth\User;

final class NoteTypesController
{
    private const DEFAULT_BASE_TYPE_KEY = 'base';
    private const DEFAULT_FILE_TYPE_KEY = 'file';
    private const DEFAULT_VIEW_TYPE_KEY = 'view';

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $baseTypeId = $this->ensureDefaultBaseType($pdo, $nookId);
        $this->ensureDefaultFileType($pdo, $nookId, $baseTypeId);
        $this->ensureDefaultViewType($pdo, $nookId, $baseTypeId);

        $stmt = $pdo->prepare(
            'select id, key, label, description, parent_id, attribute_layout, config_overrides, created_at, updated_at '
            . 'from global.note_types where nook_id = :nook_id order by label asc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $typeRows = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $row = NoteTypeRow::fromRow($r);
            $typeRows[$row->id] = $row;
        }

        // Bulk-load own attributes per type (frontend resolves inheritance via parent_id)
        $attrStmt = $pdo->prepare(
            'select id, type_id, name, key, kind, config, indexed, created_at, updated_at '
            . 'from global.type_attributes where nook_id = :nook_id order by name asc'
        );
        $attrStmt->execute([':nook_id' => $nookId]);
        $attrRows = $attrStmt->fetchAll(PDO::FETCH_ASSOC);

        $attrsByType = [];
        foreach ($attrRows as $a) {
            if (!is_array($a)) {
                continue;
            }
            $attr = TypeAttributeRow::fromRow($a);
            $attrsByType[$attr->typeId][] = $attr->toArray();
        }

        $types = [];
        foreach ($typeRows as $id => $row) {
            $types[] = ['nook_id' => $nookId] + $row->toArray() + [
                'attributes' => $attrsByType[$id] ?? [],
            ];
        }

        // Types version: max audit_meta id for type-related changes in this nook.
        // Used by frontend to skip redundant reloads when WS event carries
        // the same version it already has.
        $versionStmt = $pdo->prepare(
            "select coalesce(max(id), 0) from global.audit_meta "
            . "where nook_id = :nook_id and table_name in ('note_types', 'type_attributes')"
        );
        $versionStmt->execute([':nook_id' => $nookId]);
        $typesVersion = (int)$versionStmt->fetchColumn();

        return JsonResponse::ok(['types' => $types, 'version' => $typesVersion]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        // Schema mutations (type create/update/delete + attribute
        // create/update/delete) are owner-only. readwrite members
        // can edit notes and attach files but can't reshape the
        // schema they depend on.
        NookAccess::requireOwner($pdo, $user, $nookId);

        $payload = NoteTypeRequest::fromJson($request->jsonBody());

        if ($payload->parentId !== null) {
            $p = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $p->execute([':id' => $payload->parentId, ':nook_id' => $nookId]);
            if (!$p->fetchColumn()) {
                throw new HttpError('parent not found', 404);
            }
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'insert into global.note_types (nook_id, key, label, description, parent_id) '
                . 'values (:nook_id, :key, :label, :description, :parent_id) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':key', $payload->key);
            $stmt->bindValue(':label', $payload->label);
            $stmt->bindValue(':description', $payload->description);
            $stmt->bindValue(':parent_id', $payload->parentId);
            $stmt->execute();

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create type', 500);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'type' => [
                    'id' => Row::str($row, 'id'),
                    'nook_id' => $nookId,
                    'key' => $payload->key,
                    'label' => $payload->label,
                    'description' => $payload->description,
                    'parent_id' => $payload->parentId ?? '',
                    'attribute_layout' => null,
                    'config_overrides' => (object)[],
                    'created_at' => Row::str($row, 'created_at'),
                    'updated_at' => Row::str($row, 'updated_at'),
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function update(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $typeId = $request->requireUuidRouteParam('typeId');

        NookAccess::requireOwner($pdo, $user, $nookId);

        $keyCheck = $pdo->prepare('select key from global.note_types where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('type not found', 404);
        }

        $payload = NoteTypeRequest::fromJson($request->jsonBody());

        if ($payload->parentId === $typeId) {
            throw new HttpError('parent_id cannot be self', 400);
        }

        if ($payload->parentId !== null) {
            $p = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
            $p->execute([':id' => $payload->parentId, ':nook_id' => $nookId]);
            if (!$p->fetchColumn()) {
                throw new HttpError('parent not found', 404);
            }
        }

        if ($payload->attributeLayout !== null) {
            self::validateAttributeLayout($payload->attributeLayout);
        }

        if ($payload->key !== $existingKey) {
            $dupe = $pdo->prepare('select 1 from global.note_types where nook_id = :nook_id and key = :key and id != :id');
            $dupe->execute([':nook_id' => $nookId, ':key' => $payload->key, ':id' => $typeId]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }
        }

        $sql = 'update global.note_types set key = :key, label = :label, description = :description, parent_id = :parent_id';
        if ($payload->attributeLayout !== null) {
            $sql .= ', attribute_layout = :attribute_layout::jsonb';
        }
        if ($payload->configOverrides !== null) {
            $sql .= ', config_overrides = :config_overrides::jsonb';
        }
        $sql .= ', updated_at = now() where id = :id and nook_id = :nook_id returning description, attribute_layout, config_overrides, created_at, updated_at';

        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':id', $typeId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':key', $payload->key);
        $stmt->bindValue(':label', $payload->label);
        $stmt->bindValue(':description', $payload->description);
        $stmt->bindValue(':parent_id', $payload->parentId);
        if ($payload->attributeLayout !== null) {
            $stmt->bindValue(':attribute_layout', json_encode($payload->attributeLayout));
        }
        if ($payload->configOverrides !== null) {
            $stmt->bindValue(':config_overrides', json_encode($payload->configOverrides));
        }
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('type not found', 404);
        }

        return JsonResponse::ok([
            'type' => [
                'id' => $typeId,
                'nook_id' => $nookId,
                'key' => $payload->key,
                'label' => $payload->label,
                'description' => Row::str($row, 'description', $payload->description),
                'parent_id' => $payload->parentId ?? '',
                'attribute_layout' => Row::decodeJsonObject($row['attribute_layout'] ?? null) ?: null,
                'config_overrides' => Row::decodeJsonObject($row['config_overrides'] ?? null) ?: (object)[],
                'created_at' => Row::str($row, 'created_at'),
                'updated_at' => Row::str($row, 'updated_at'),
            ],
        ]);
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $typeId = $request->requireUuidRouteParam('typeId');

        NookAccess::requireOwner($pdo, $user, $nookId);

        $typeCheck = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
        $typeCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        if (!$typeCheck->fetchColumn()) {
            throw new HttpError('type not found', 404);
        }

        // Prevent deletion if type has children
        $childCheck = $pdo->prepare('select 1 from global.note_types where parent_id = :id and nook_id = :nook_id limit 1');
        $childCheck->execute([':id' => $typeId, ':nook_id' => $nookId]);
        if ($childCheck->fetchColumn()) {
            throw new HttpError('cannot delete type that has child types — delete or reparent children first', 400);
        }

        // Unset type_id on notes (attributes stay as inert JSONB)
        $pdo->prepare('update global.notes set type_id = null where type_id = :type_id and nook_id = :nook_id')
            ->execute([':type_id' => $typeId, ':nook_id' => $nookId]);

        $stmt = $pdo->prepare('delete from global.note_types where id = :id and nook_id = :nook_id returning id');
        $stmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('type not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'type_id' => $typeId,
        ]);
    }

    /**
     * Ensure the base type exists. All other types inherit from it.
     * Returns the base type ID.
     */
    private function ensureDefaultBaseType(PDO $pdo, string $nookId): string
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_BASE_TYPE_KEY]);
        $existing = $check->fetchColumn();
        if ($existing) {
            return (string)$existing;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, description) '
            . 'values (:nook_id, :key, :label, :description) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_BASE_TYPE_KEY,
            ':label' => 'Note',
            ':description' => 'Base type — all other types inherit its attributes',
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $seedAttr = function (string $name, string $key, string $kind, array $config) use ($pdo, $nookId, $typeId): void {
                $pdo->prepare(
                    "insert into global.type_attributes (nook_id, type_id, name, key, kind, config) "
                    . "values (:nook_id, :type_id, :name, :key, :kind, :config::jsonb) "
                    . "on conflict do nothing"
                )->execute([
                    ':nook_id' => $nookId,
                    ':type_id' => $typeId,
                    ':name' => $name,
                    ':key' => $key,
                    ':kind' => $kind,
                    ':config' => json_encode($config ?: (object)[]),
                ]);
            };

            $seedAttr('Links', 'links', 'linked_notes', ['direction' => 'both', 'display' => 'list']);
            $seedAttr('Mentions', 'mentions', 'mentions', ['direction' => 'both']);
            $seedAttr('Content', 'content', 'content', ['mode' => 'markdown']);
            $seedAttr('Info', 'info', 'metadata', ['show_version' => true, 'show_created' => true, 'show_updated' => true, 'show_views' => true]);
            $seedAttr('Table of Contents', 'toc', 'toc', ['max_depth' => 3]);
            $seedAttr('History', 'history', 'history', ['limit' => 5]);
            $seedAttr('Source', 'source', 'source', []);
        }

        return $typeId;
    }

    private function ensureDefaultFileType(PDO $pdo, string $nookId, string $baseTypeId): void
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_FILE_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id) '
            . 'values (:nook_id, :key, :label, :parent_id) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_FILE_TYPE_KEY,
            ':label' => 'File',
            ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $attrStmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'File', 'file', '{\"display\": \"preview\"}'::jsonb) "
                . "on conflict do nothing"
            );
            $attrStmt->execute([':nook_id' => $nookId, ':type_id' => $typeId]);
        }
    }

    private function ensureDefaultViewType(PDO $pdo, string $nookId, string $baseTypeId): void
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_VIEW_TYPE_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, parent_id) '
            . 'values (:nook_id, :key, :label, :parent_id) '
            . 'returning id'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_VIEW_TYPE_KEY,
            ':label' => 'View',
            ':parent_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $typeIdRaw = $stmt->fetchColumn();
        $typeId = is_scalar($typeIdRaw) ? (string)$typeIdRaw : '';

        if ($typeId !== '') {
            $attrStmt = $pdo->prepare(
                "insert into global.type_attributes (nook_id, type_id, name, kind, config) "
                . "values (:nook_id, :type_id, 'View', 'view', '{}'::jsonb) "
                . "on conflict do nothing"
            );
            $attrStmt->execute([':nook_id' => $nookId, ':type_id' => $typeId]);
        }
    }

    /** @param array<string, mixed> $layout */
    private static function validateAttributeLayout(array $layout): void
    {
        $panels = $layout['panels'] ?? null;
        if (!is_array($panels)) {
            throw new HttpError('attribute_layout.panels must be an array', 400);
        }

        $validPositions = ['main', 'side-right', 'side-left'];
        $seenKeys = [];
        $seenAttrIds = [];
        $mainCount = 0;

        foreach ($panels as $panel) {
            if (!is_array($panel)) {
                throw new HttpError('each panel must be an object', 400);
            }

            $key = $panel['key'] ?? null;
            if (!is_string($key) || trim($key) === '') {
                throw new HttpError('panel.key is required', 400);
            }
            if (isset($seenKeys[$key])) {
                throw new HttpError('duplicate panel key: ' . $key, 400);
            }
            $seenKeys[$key] = true;

            $position = $panel['position'] ?? null;
            if (!is_string($position) || !in_array($position, $validPositions, true)) {
                throw new HttpError('panel.position must be one of: ' . implode(', ', $validPositions), 400);
            }

            if ($position === 'main') {
                $mainCount++;
            }

            $attrs = $panel['attributes'] ?? [];
            if (!is_array($attrs)) {
                throw new HttpError('panel.attributes must be an array', 400);
            }
            foreach ($attrs as $attrId) {
                if (!is_string($attrId)) {
                    throw new HttpError('panel.attributes entries must be strings', 400);
                }
                if (isset($seenAttrIds[$attrId])) {
                    throw new HttpError('attribute appears in multiple panels: ' . $attrId, 400);
                }
                $seenAttrIds[$attrId] = true;
            }
        }

        if ($mainCount > 1) {
            throw new HttpError('only one panel may have position "main"', 400);
        }
    }
}
