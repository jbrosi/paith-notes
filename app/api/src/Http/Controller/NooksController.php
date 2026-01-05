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
                nm.role
            from global.nooks n
            join global.nook_members nm on nm.nook_id = n.id
            where 
                nm.user_id = :user_id
            order by n.created_at desc;
        ");
        $stmt->execute([':user_id' => $user['id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return JsonResponse::ok([
            'nooks' => array_map(static function (mixed $r): array {
                if (!is_array($r)) {
                    return ['id' => '', 'name' => '', 'role' => ''];
                }

                $id = $r['id'] ?? '';
                $name = $r['name'] ?? '';
                $role = $r['role'] ?? '';

                return [
                    'id' => is_scalar($id) ? (string)$id : '',
                    'name' => is_scalar($name) ? (string)$name : '',
                    'role' => is_scalar($role) ? (string)$role : '',
                ];
            }, $rows),
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
