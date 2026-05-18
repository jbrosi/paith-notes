<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\HttpError;
use PDO;

final class NookAccess
{
    public static function requireMember(PDO $pdo, array $user, string $nookId): array
    {
        $check = $pdo->prepare('select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([
            ':nook_id' => $nookId,
            ':user_id' => $user['id'],
        ]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('forbidden', 403);
        }
        /** @var array<string, mixed> $row */
        return $row;
    }

    public static function requireWriteAccess(PDO $pdo, array $user, string $nookId): array
    {
        $membership = self::requireMember($pdo, $user, $nookId);
        $role = is_scalar($membership['role'] ?? null) ? (string) $membership['role'] : '';
        if ($role === 'readonly') {
            throw new HttpError('this nook is shared with you as read-only', 403);
        }
        return $membership;
    }

    public static function requireOwner(PDO $pdo, array $user, string $nookId): array
    {
        $membership = self::requireMember($pdo, $user, $nookId);
        $role = is_scalar($membership['role'] ?? null) ? (string) $membership['role'] : '';
        if ($role !== 'owner') {
            throw new HttpError('only the nook owner can perform this action', 403);
        }
        return $membership;
    }

    public static function isUuid(string $value): bool
    {
        return (bool) preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
