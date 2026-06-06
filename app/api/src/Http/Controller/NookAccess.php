<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\HttpError;
use PDO;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Api\Http\Auth\User;

final class NookAccess
{
    /**
     * Verify the user is a member of the nook. Returns their NookRole.
     */
    public static function requireMember(PDO $pdo, User $user, string $nookId): NookRole
    {
        $check = $pdo->prepare('select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([
            ':nook_id' => $nookId,
            ':user_id' => $user->id,
        ]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('forbidden', 403);
        }
        return NookRole::from(Row::str($row, 'role'));
    }

    /**
     * Verify the user can write to this nook. Returns their NookRole so
     * callers can distinguish between Owner (full control) and Readwrite
     * (own-note-only) for downstream checks.
     */
    public static function requireWriteAccess(PDO $pdo, User $user, string $nookId): NookRole
    {
        $role = self::requireMember($pdo, $user, $nookId);
        if ($role === NookRole::Readonly) {
            throw new HttpError('this nook is shared with you as read-only', 403);
        }
        return $role;
    }

    /**
     * Verify the user owns this nook.
     */
    public static function requireOwner(PDO $pdo, User $user, string $nookId): NookRole
    {
        $role = self::requireMember($pdo, $user, $nookId);
        if ($role !== NookRole::Owner) {
            throw new HttpError('only the nook owner can perform this action', 403);
        }
        return $role;
    }
}
