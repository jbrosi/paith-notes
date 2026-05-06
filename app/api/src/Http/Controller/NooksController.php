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

final class NooksController
{
    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $stmt = $pdo->prepare("
            select
                n.id,
                n.name,
                nm.role,
                n.owner_id,
                u.first_name as owner_first_name,
                u.last_name as owner_last_name
            from global.nooks n
            join global.nook_members nm on nm.nook_id = n.id
            join global.users u on u.id = n.owner_id
            where
                nm.user_id = :user_id
            order by n.created_at desc;
        ");
        $stmt->execute([':user_id' => $user['id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';

        $nooks = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $id = $r['id'] ?? '';
            $name = $r['name'] ?? '';
            $role = $r['role'] ?? '';
            $ownerId = $r['owner_id'] ?? null;

            $isOwned = is_scalar($ownerId) && (string)$ownerId === $userId;
            $ownerFirst = is_scalar($r['owner_first_name'] ?? null) ? (string)$r['owner_first_name'] : '';
            $ownerLast = is_scalar($r['owner_last_name'] ?? null) ? (string)$r['owner_last_name'] : '';
            $ownerName = trim($ownerFirst . ' ' . $ownerLast);

            $nooks[] = [
                'id' => is_scalar($id) ? (string)$id : '',
                'name' => is_scalar($name) ? (string)$name : '',
                'role' => is_scalar($role) ? (string)$role : '',
                'is_owned' => $isOwned,
                'owner_name' => $isOwned ? '' : $ownerName,
            ];
        }

        return JsonResponse::ok([
            'nooks' => $nooks,
        ]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $data = $request->jsonBody();

        $nameRaw = $data['name'] ?? '';
        $name = is_string($nameRaw) ? trim($nameRaw) : '';
        if ($name === '') {
            throw new HttpError('name is required', 400);
        }

        try {
            $pdo->beginTransaction();

            $create = $pdo->prepare("
                insert into global.nooks (name, created_by, owner_id)
                values (:name, :created_by, :owner_id)
                returning id
            ");
            $create->execute([
                ':name' => $name,
                ':created_by' => $user['id'],
                ':owner_id' => $user['id'],
            ]);
            $nookId = (string)$create->fetchColumn();

            $member = $pdo->prepare("\n                insert into global.nook_members (nook_id, user_id, role)\n                values (:nook_id, :user_id, 'owner')\n                on conflict (nook_id, user_id) do update set role = excluded.role\n            ");
            $member->execute([
                ':nook_id' => $nookId,
                ':user_id' => $user['id'],
            ]);

            $pdo->commit();

            return JsonResponse::ok([
                'nook' => [
                    'id' => $nookId,
                    'name' => $name,
                    'role' => 'owner',
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $data = $request->jsonBody();

        $nameRaw = $data['name'] ?? '';
        $name = is_string($nameRaw) ? trim($nameRaw) : '';
        if ($name === '') {
            throw new HttpError('name is required', 400);
        }

        $stmt = $pdo->prepare('update global.nooks set name = :name where id = :id returning id, name');
        $stmt->execute([':name' => $name, ':id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('nook not found', 404);
        }

        return JsonResponse::ok([
            'nook' => [
                'id' => is_scalar($row['id'] ?? null) ? (string)$row['id'] : '',
                'name' => is_scalar($row['name'] ?? null) ? (string)$row['name'] : '',
            ],
        ]);
    }
}
