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

final class InvitationsController
{
    // ── Owner endpoints (nook-scoped) ──

    public function invite(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !NookAccess::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $data = $request->jsonBody();
        $email = is_string($data['email'] ?? null) ? trim(strtolower($data['email'])) : '';
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError('a valid email is required', 400);
        }

        $roleRaw = is_string($data['role'] ?? null) ? trim($data['role']) : 'readonly';
        if (!in_array($roleRaw, ['readonly', 'readwrite'], true)) {
            throw new HttpError('role must be readonly or readwrite', 400);
        }

        // Check if email is already a member
        $memberCheck = $pdo->prepare("
            select 1 from global.nook_members nm
            join global.users u on u.id = nm.user_id
            where nm.nook_id = :nook_id and lower(u.email) = :email
            limit 1
        ");
        $memberCheck->execute([':nook_id' => $nookId, ':email' => $email]);
        if ($memberCheck->fetch()) {
            throw new HttpError('this user is already a member of this nook', 409);
        }

        $stmt = $pdo->prepare("
            insert into global.nook_invitations (nook_id, invited_email, role, invited_by)
            values (:nook_id, :email, :role, :invited_by)
            on conflict do nothing
            returning id, created_at
        ");
        $stmt->execute([
            ':nook_id' => $nookId,
            ':email' => $email,
            ':role' => $roleRaw,
            ':invited_by' => $user['id'],
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('an invitation for this email already exists', 409);
        }

        return JsonResponse::ok([
            'invitation' => [
                'id' => is_scalar($row['id'] ?? null) ? (string) $row['id'] : '',
                'nook_id' => $nookId,
                'invited_email' => $email,
                'role' => $roleRaw,
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string) $row['created_at'] : '',
            ],
        ]);
    }

    public function listForNook(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !NookAccess::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $stmt = $pdo->prepare("
            select
                i.id, i.invited_email, i.role, i.accepted_at, i.declined_at, i.created_at,
                u.first_name as inviter_first_name, u.last_name as inviter_last_name
            from global.nook_invitations i
            join global.users u on u.id = i.invited_by
            where i.nook_id = :nook_id
            order by i.created_at desc
        ");
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $invitations = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $acceptedAt = $r['accepted_at'] ?? null;
            $declinedAt = $r['declined_at'] ?? null;
            $status = is_scalar($acceptedAt) ? 'accepted'
                : (is_scalar($declinedAt) ? 'declined' : 'pending');

            $firstName = is_scalar($r['inviter_first_name'] ?? null) ? (string) $r['inviter_first_name'] : '';
            $lastName = is_scalar($r['inviter_last_name'] ?? null) ? (string) $r['inviter_last_name'] : '';

            $invitations[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string) $r['id'] : '',
                'invited_email' => is_scalar($r['invited_email'] ?? null) ? (string) $r['invited_email'] : '',
                'role' => is_scalar($r['role'] ?? null) ? (string) $r['role'] : '',
                'status' => $status,
                'inviter_name' => trim($firstName . ' ' . $lastName),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string) $r['created_at'] : '',
            ];
        }

        return JsonResponse::ok(['invitations' => $invitations]);
    }

    public function revokeInvitation(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        $invId = trim($request->routeParam('invId'));
        if ($nookId === '' || !NookAccess::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }
        if ($invId === '' || !NookAccess::isUuid($invId)) {
            throw new HttpError('invId must be a UUID', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $stmt = $pdo->prepare('delete from global.nook_invitations where id = :id and nook_id = :nook_id');
        $stmt->execute([':id' => $invId, ':nook_id' => $nookId]);

        return JsonResponse::ok(['deleted' => true]);
    }

    public function revokeMember(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        $memberId = trim($request->routeParam('userId'));
        if ($nookId === '' || !NookAccess::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }
        if ($memberId === '' || !NookAccess::isUuid($memberId)) {
            throw new HttpError('userId must be a UUID', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';
        if ($memberId === $userId) {
            throw new HttpError('you cannot revoke your own access', 400);
        }

        // Verify target is actually a member
        $check = $pdo->prepare(
            'select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1'
        );
        $check->execute([':nook_id' => $nookId, ':user_id' => $memberId]);
        $memberRow = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($memberRow)) {
            throw new HttpError('user is not a member of this nook', 404);
        }

        try {
            $pdo->beginTransaction();

            // Get nook name for the revocation notice
            $nookStmt = $pdo->prepare('select name from global.nooks where id = :id');
            $nookStmt->execute([':id' => $nookId]);
            $nookRow = $nookStmt->fetch(PDO::FETCH_ASSOC);
            $nookName = is_array($nookRow) && is_scalar($nookRow['name'] ?? null) ? (string) $nookRow['name'] : '';

            // Remove membership
            $del = $pdo->prepare('delete from global.nook_members where nook_id = :nook_id and user_id = :user_id');
            $del->execute([':nook_id' => $nookId, ':user_id' => $memberId]);

            // Create revocation notice
            $notice = $pdo->prepare("
                insert into global.nook_access_revocations (nook_id, user_id, nook_name, revoked_by)
                values (:nook_id, :user_id, :nook_name, :revoked_by)
            ");
            $notice->execute([
                ':nook_id' => $nookId,
                ':user_id' => $memberId,
                ':nook_name' => $nookName,
                ':revoked_by' => $userId,
            ]);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return JsonResponse::ok(['deleted' => true]);
    }

    public function listMembers(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !NookAccess::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        NookAccess::requireOwner($pdo, $user, $nookId);

        $stmt = $pdo->prepare("
            select
                u.id, u.first_name, u.last_name, u.email, nm.role, nm.created_at
            from global.nook_members nm
            join global.users u on u.id = nm.user_id
            where nm.nook_id = :nook_id
            order by nm.created_at asc
        ");
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $members = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $firstName = is_scalar($r['first_name'] ?? null) ? (string) $r['first_name'] : '';
            $lastName = is_scalar($r['last_name'] ?? null) ? (string) $r['last_name'] : '';

            $members[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string) $r['id'] : '',
                'name' => trim($firstName . ' ' . $lastName),
                'email' => is_scalar($r['email'] ?? null) ? (string) $r['email'] : '',
                'role' => is_scalar($r['role'] ?? null) ? (string) $r['role'] : '',
                'joined_at' => is_scalar($r['created_at'] ?? null) ? (string) $r['created_at'] : '',
            ];
        }

        return JsonResponse::ok(['members' => $members]);
    }

    // ── User endpoints (me-scoped) ──

    private function getUserEmail(PDO $pdo, array $user): string
    {
        // The user array from dev-header auth may not include email,
        // so always look it up from the DB.
        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';
        if ($userId === '') {
            return '';
        }
        $stmt = $pdo->prepare('select email from global.users where id = :id');
        $stmt->execute([':id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return '';
        }
        return is_scalar($row['email'] ?? null) ? strtolower(trim((string) $row['email'])) : '';
    }

    public function listForMe(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $email = $this->getUserEmail($pdo, $user);
        if ($email === '') {
            return JsonResponse::ok(['invitations' => []]);
        }

        $stmt = $pdo->prepare("
            select
                i.id, i.nook_id, i.role, i.created_at,
                n.name as nook_name,
                u.first_name as inviter_first_name, u.last_name as inviter_last_name
            from global.nook_invitations i
            join global.nooks n on n.id = i.nook_id
            join global.users u on u.id = i.invited_by
            where lower(i.invited_email) = :email
              and i.accepted_at is null
              and i.declined_at is null
            order by i.created_at desc
        ");
        $stmt->execute([':email' => $email]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $invitations = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $firstName = is_scalar($r['inviter_first_name'] ?? null) ? (string) $r['inviter_first_name'] : '';
            $lastName = is_scalar($r['inviter_last_name'] ?? null) ? (string) $r['inviter_last_name'] : '';

            $invitations[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string) $r['id'] : '',
                'nook_id' => is_scalar($r['nook_id'] ?? null) ? (string) $r['nook_id'] : '',
                'nook_name' => is_scalar($r['nook_name'] ?? null) ? (string) $r['nook_name'] : '',
                'role' => is_scalar($r['role'] ?? null) ? (string) $r['role'] : '',
                'inviter_name' => trim($firstName . ' ' . $lastName),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string) $r['created_at'] : '',
            ];
        }

        return JsonResponse::ok(['invitations' => $invitations]);
    }

    public function listRevocations(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';

        $stmt = $pdo->prepare("
            select
                r.id, r.nook_name, r.created_at,
                u.first_name as revoker_first_name, u.last_name as revoker_last_name
            from global.nook_access_revocations r
            join global.users u on u.id = r.revoked_by
            where r.user_id = :user_id
              and r.dismissed_at is null
            order by r.created_at desc
        ");
        $stmt->execute([':user_id' => $userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $revocations = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $firstName = is_scalar($r['revoker_first_name'] ?? null) ? (string) $r['revoker_first_name'] : '';
            $lastName = is_scalar($r['revoker_last_name'] ?? null) ? (string) $r['revoker_last_name'] : '';

            $revocations[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string) $r['id'] : '',
                'nook_name' => is_scalar($r['nook_name'] ?? null) ? (string) $r['nook_name'] : '',
                'revoked_by_name' => trim($firstName . ' ' . $lastName),
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string) $r['created_at'] : '',
            ];
        }

        return JsonResponse::ok(['revocations' => $revocations]);
    }

    public function acceptInvitation(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $invId = trim($request->routeParam('invId'));
        if ($invId === '' || !NookAccess::isUuid($invId)) {
            throw new HttpError('invId must be a UUID', 400);
        }

        $email = $this->getUserEmail($pdo, $user);
        if ($email === '') {
            throw new HttpError('your account has no email address', 400);
        }

        // Find the pending invitation for this user
        $stmt = $pdo->prepare("
            select id, nook_id, role
            from global.nook_invitations
            where id = :id
              and lower(invited_email) = :email
              and accepted_at is null
              and declined_at is null
        ");
        $stmt->execute([':id' => $invId, ':email' => $email]);
        $inv = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($inv)) {
            throw new HttpError('invitation not found or already processed', 404);
        }

        $nookId = is_scalar($inv['nook_id'] ?? null) ? (string) $inv['nook_id'] : '';
        $role = is_scalar($inv['role'] ?? null) ? (string) $inv['role'] : 'readonly';

        try {
            $pdo->beginTransaction();

            $member = $pdo->prepare("
                insert into global.nook_members (nook_id, user_id, role)
                values (:nook_id, :user_id, :role)
                on conflict (nook_id, user_id) do update set role = excluded.role
            ");
            $member->execute([
                ':nook_id' => $nookId,
                ':user_id' => $user['id'],
                ':role' => $role,
            ]);

            $accept = $pdo->prepare('update global.nook_invitations set accepted_at = now() where id = :id');
            $accept->execute([':id' => $invId]);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return JsonResponse::ok(['accepted' => true, 'nook_id' => $nookId]);
    }

    public function declineInvitation(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $invId = trim($request->routeParam('invId'));
        if ($invId === '' || !NookAccess::isUuid($invId)) {
            throw new HttpError('invId must be a UUID', 400);
        }

        $email = $this->getUserEmail($pdo, $user);
        if ($email === '') {
            throw new HttpError('your account has no email address', 400);
        }

        $stmt = $pdo->prepare("
            update global.nook_invitations
            set declined_at = now()
            where id = :id
              and lower(invited_email) = :email
              and accepted_at is null
              and declined_at is null
        ");
        $stmt->execute([':id' => $invId, ':email' => $email]);

        return JsonResponse::ok(['declined' => true]);
    }

    public function dismissRevocation(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $revId = trim($request->routeParam('revId'));
        if ($revId === '' || !NookAccess::isUuid($revId)) {
            throw new HttpError('revId must be a UUID', 400);
        }

        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';

        $stmt = $pdo->prepare("
            update global.nook_access_revocations
            set dismissed_at = now()
            where id = :id and user_id = :user_id
        ");
        $stmt->execute([':id' => $revId, ':user_id' => $userId]);

        return JsonResponse::ok(['dismissed' => true]);
    }
}
