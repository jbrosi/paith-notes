<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;

final class SavedViewsController
{
    private const VALID_DISPLAYS = ['list', 'cards', 'table'];

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'select id, nook_id, name, type_id, filters, sort, display, created_at, updated_at '
            . 'from global.saved_views where nook_id = :nook_id order by name asc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $views = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $views[] = self::formatView($r);
        }

        return JsonResponse::ok(['views' => $views]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $name = self::requireString($data, 'name');
        $typeId = isset($data['type_id']) && is_string($data['type_id']) ? trim($data['type_id']) : '';
        if ($typeId !== '' && !self::isUuid($typeId)) {
            throw new HttpError('type_id must be a UUID', 400);
        }

        $filters = is_array($data['filters'] ?? null) ? $data['filters'] : [];
        $sort = is_array($data['sort'] ?? null) ? $data['sort'] : [];
        $display = is_string($data['display'] ?? null) ? trim($data['display']) : 'list';
        if (!in_array($display, self::VALID_DISPLAYS, true)) {
            $display = 'list';
        }

        $stmt = $pdo->prepare(
            'insert into global.saved_views (nook_id, name, type_id, filters, sort, display) '
            . 'values (:nook_id, :name, :type_id, :filters::jsonb, :sort::jsonb, :display) '
            . 'returning id, created_at, updated_at'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':name' => $name,
            ':type_id' => $typeId !== '' ? $typeId : null,
            ':filters' => json_encode($filters),
            ':sort' => json_encode($sort === [] ? (object)[] : $sort),
            ':display' => $display,
        ]);

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('failed to create view', 500);
        }

        return JsonResponse::ok([
            'view' => [
                'id' => is_scalar($row['id'] ?? null) ? (string)$row['id'] : '',
                'nook_id' => $nookId,
                'name' => $name,
                'type_id' => $typeId,
                'filters' => $filters,
                'sort' => $sort === [] ? (object)[] : $sort,
                'display' => $display,
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
            ],
        ]);
    }

    public function update(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $viewId = self::requireUuid($request->routeParam('viewId'), 'viewId');
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $name = self::requireString($data, 'name');
        $typeId = isset($data['type_id']) && is_string($data['type_id']) ? trim($data['type_id']) : '';
        if ($typeId !== '' && !self::isUuid($typeId)) {
            throw new HttpError('type_id must be a UUID', 400);
        }

        $filters = is_array($data['filters'] ?? null) ? $data['filters'] : [];
        $sort = is_array($data['sort'] ?? null) ? $data['sort'] : [];
        $display = is_string($data['display'] ?? null) ? trim($data['display']) : 'list';
        if (!in_array($display, self::VALID_DISPLAYS, true)) {
            $display = 'list';
        }

        $stmt = $pdo->prepare(
            'update global.saved_views set name = :name, type_id = :type_id, filters = :filters::jsonb, '
            . 'sort = :sort::jsonb, display = :display, updated_at = now() '
            . 'where id = :id and nook_id = :nook_id '
            . 'returning created_at, updated_at'
        );
        $stmt->execute([
            ':id' => $viewId,
            ':nook_id' => $nookId,
            ':name' => $name,
            ':type_id' => $typeId !== '' ? $typeId : null,
            ':filters' => json_encode($filters),
            ':sort' => json_encode($sort === [] ? (object)[] : $sort),
            ':display' => $display,
        ]);

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('view not found', 404);
        }

        return JsonResponse::ok([
            'view' => [
                'id' => $viewId,
                'nook_id' => $nookId,
                'name' => $name,
                'type_id' => $typeId,
                'filters' => $filters,
                'sort' => $sort === [] ? (object)[] : $sort,
                'display' => $display,
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
            ],
        ]);
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = self::requireUuid($request->routeParam('nookId'), 'nookId');
        $viewId = self::requireUuid($request->routeParam('viewId'), 'viewId');
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $stmt = $pdo->prepare('delete from global.saved_views where id = :id and nook_id = :nook_id returning id');
        $stmt->execute([':id' => $viewId, ':nook_id' => $nookId]);
        if (!$stmt->fetchColumn()) {
            throw new HttpError('view not found', 404);
        }

        return JsonResponse::ok(['deleted' => true, 'view_id' => $viewId]);
    }

    /** @return array<string, mixed> */
    private static function formatView(array $r): array
    {
        $filters = [];
        $filtersRaw = $r['filters'] ?? '[]';
        if (is_scalar($filtersRaw)) {
            $decoded = json_decode((string)$filtersRaw, true);
            if (is_array($decoded)) $filters = $decoded;
        }

        $sort = [];
        $sortRaw = $r['sort'] ?? '{}';
        if (is_scalar($sortRaw)) {
            $decoded = json_decode((string)$sortRaw, true);
            if (is_array($decoded)) $sort = $decoded;
        }

        return [
            'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
            'nook_id' => is_scalar($r['nook_id'] ?? null) ? (string)$r['nook_id'] : '',
            'name' => is_scalar($r['name'] ?? null) ? (string)$r['name'] : '',
            'type_id' => is_scalar($r['type_id'] ?? null) ? (string)$r['type_id'] : '',
            'filters' => $filters,
            'sort' => $sort === [] ? (object)[] : $sort,
            'display' => is_scalar($r['display'] ?? null) ? (string)$r['display'] : 'list',
            'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
            'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
        ];
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): void
    {
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') throw new HttpError('invalid user', 500);
        $check = $pdo->prepare('select 1 from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([':nook_id' => $nookId, ':user_id' => $userId]);
        if (!$check->fetch()) throw new HttpError('forbidden', 403);
    }

    private static function requireUuid(string $value, string $name): string
    {
        $v = trim($value);
        if ($v === '') throw new HttpError($name . ' is required', 400);
        if (!self::isUuid($v)) throw new HttpError($name . ' must be a UUID', 400);
        return $v;
    }

    private static function requireString(array $data, string $key): string
    {
        $raw = $data[$key] ?? '';
        $val = is_string($raw) ? trim($raw) : '';
        if ($val === '') throw new HttpError($key . ' is required', 400);
        return $val;
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value);
    }
}
