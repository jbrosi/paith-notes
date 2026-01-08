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
                n.is_personal,
                n.personal_owner_id
            from global.nooks n
            join global.nook_members nm on nm.nook_id = n.id
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
            $personalOwnerId = $r['personal_owner_id'] ?? null;

            $isPersonal = (bool)($r['is_personal'] ?? false);
            if (is_scalar($personalOwnerId) && (string)$personalOwnerId === $userId) {
                $isPersonal = true;
            }

            $nooks[] = [
                'id' => is_scalar($id) ? (string)$id : '',
                'name' => is_scalar($name) ? (string)$name : '',
                'role' => is_scalar($role) ? (string)$role : '',
                'is_personal' => $isPersonal,
            ];
        }

        return JsonResponse::ok([
            'nooks' => $nooks,
        ]);
    }

    public function personal(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('missing user id', 500);
        }

        $stmt = $pdo->prepare('select id, name from global.nooks where personal_owner_id = :user_id limit 1');
        $stmt->execute([':user_id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('personal nook not found', 404);
        }

        $id = $row['id'] ?? '';
        $name = $row['name'] ?? '';

        return JsonResponse::ok([
            'nook' => [
                'id' => is_scalar($id) ? (string)$id : '',
                'name' => is_scalar($name) ? (string)$name : '',
                'is_personal' => true,
            ],
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

            $create = $pdo->prepare("\n                insert into global.nooks (name, created_by)\n                values (:name, :created_by)\n                returning id\n            ");
            $create->execute([
                ':name' => $name,
                ':created_by' => $user['id'],
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
}
