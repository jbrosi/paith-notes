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
use Paith\Notes\Shared\Db\Row;

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
                n.purpose,
                nm.role,
                n.owner_id,
                u.first_name as owner_first_name,
                u.last_name as owner_last_name,
                unp.settings as user_settings
            from global.nooks n
            join global.nook_members nm on nm.nook_id = n.id
            join global.users u on u.id = n.owner_id
            left join global.user_nook_preferences unp on unp.nook_id = n.id and unp.user_id = nm.user_id
            where
                nm.user_id = :user_id
                and n.purpose in ('general', 'handbook')
            order by n.created_at desc;
        ");
        $stmt->execute([':user_id' => $user['id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $userId = Row::str($user, 'id');

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
            $ownerFirst = Row::str($r, 'owner_first_name');
            $ownerLast = Row::str($r, 'owner_last_name');
            $ownerName = trim($ownerFirst . ' ' . $ownerLast);

            $userSettings = [];
            if (is_scalar($r['user_settings'] ?? null)) {
                $decoded = json_decode((string)$r['user_settings'], true);
                if (is_array($decoded)) {
                    $userSettings = $decoded;
                }
            }

            $nooks[] = [
                'id' => is_scalar($id) ? (string)$id : '',
                'name' => is_scalar($name) ? (string)$name : '',
                'role' => is_scalar($role) ? (string)$role : '',
                'is_owned' => $isOwned,
                'owner_name' => $isOwned ? '' : $ownerName,
                'accent_color' => is_string($userSettings['accent_color'] ?? null) ? $userSettings['accent_color'] : null,
            ];
        }

        return JsonResponse::ok([
            'nooks' => $nooks,
        ]);
    }

    public function aiMemory(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = Row::str($user, 'id');

        $stmt = $pdo->prepare(
            "select n.id, n.name from global.nooks n join global.nook_members nm on nm.nook_id = n.id where nm.user_id = :user_id and n.purpose = 'ai-memory' limit 1"
        );
        $stmt->execute([':user_id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('AI memory nook not found', 404);
        }

        return JsonResponse::ok([
            'nook' => [
                'id' => Row::str($row, 'id'),
                'name' => Row::str($row, 'name'),
                'purpose' => 'ai-memory',
            ],
        ]);
    }

    public function handbook(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = Row::str($user, 'id');

        $stmt = $pdo->prepare(
            "select n.id, n.name from global.nooks n join global.nook_members nm on nm.nook_id = n.id where nm.user_id = :user_id and n.purpose = 'handbook' limit 1"
        );
        $stmt->execute([':user_id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('Handbook nook not found', 404);
        }

        return JsonResponse::ok([
            'nook' => [
                'id' => Row::str($row, 'id'),
                'name' => Row::str($row, 'name'),
                'purpose' => 'handbook',
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
                'id' => Row::str($row, 'id'),
                'name' => Row::str($row, 'name'),
            ],
        ]);
    }

    public function getPreferences(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = Row::str($user, 'id');
        $nookId = trim($request->routeParam('nookId'));

        $stmt = $pdo->prepare(
            'select settings from global.user_nook_preferences where user_id = :user_id and nook_id = :nook_id'
        );
        $stmt->execute([':user_id' => $userId, ':nook_id' => $nookId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        $settings = [];
        if (is_array($row) && is_scalar($row['settings'] ?? null)) {
            $decoded = json_decode((string)$row['settings'], true);
            if (is_array($decoded)) {
                $settings = $decoded;
            }
        }

        return JsonResponse::ok(['settings' => $settings]);
    }

    public function updatePreferences(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $userId = Row::str($user, 'id');
        $nookId = trim($request->routeParam('nookId'));

        $data = $request->jsonBody();
        $settings = is_array($data['settings'] ?? null) ? $data['settings'] : [];

        $pdo->prepare(
            "insert into global.user_nook_preferences (user_id, nook_id, settings)
             values (:user_id, :nook_id, :settings)
             on conflict (user_id, nook_id) do update set settings = :settings2"
        )->execute([
            ':user_id' => $userId,
            ':nook_id' => $nookId,
            ':settings' => json_encode($settings),
            ':settings2' => json_encode($settings),
        ]);

        return JsonResponse::ok(['settings' => $settings]);
    }
}
