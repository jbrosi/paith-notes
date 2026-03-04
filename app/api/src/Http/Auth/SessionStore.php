<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

use PDO;
use RuntimeException;

final class SessionStore
{
    private const COOKIE_NAME = 'paith_session';

    public static function cookieName(): string
    {
        return self::COOKIE_NAME;
    }

    public static function createAuthState(PDO $pdo, string $state, string $redirectTo, string $codeVerifier, int $ttlSeconds): void
    {
        $stmt = $pdo->prepare(
            "insert into global.auth_states (state, redirect_to, code_verifier, expires_at) values (:state, :redirect_to, :code_verifier, now() + (:ttl || ' seconds')::interval)"
        );
        $stmt->execute([
            ':state' => $state,
            ':redirect_to' => $redirectTo,
            ':code_verifier' => $codeVerifier,
            ':ttl' => (string)$ttlSeconds,
        ]);
    }

    /** @return array{redirect_to: string, code_verifier: string} */
    public static function consumeAuthState(PDO $pdo, string $state): array
    {
        if ($state === '') {
            throw new RuntimeException('missing state');
        }

        $pdo->beginTransaction();
        try {
            $sel = $pdo->prepare('select redirect_to, code_verifier from global.auth_states where state = :state and expires_at > now()');
            $sel->execute([':state' => $state]);
            $row = $sel->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new RuntimeException('invalid or expired auth state');
            }

            $del = $pdo->prepare('delete from global.auth_states where state = :state');
            $del->execute([':state' => $state]);

            $pdo->commit();

            return [
                'redirect_to' => is_scalar($row['redirect_to'] ?? null) ? (string)$row['redirect_to'] : '/',
                'code_verifier' => is_scalar($row['code_verifier'] ?? null) ? (string)$row['code_verifier'] : '',
            ];
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public static function createSession(PDO $pdo, string $userId, string $tokenEncrypted, int $ttlSeconds): string
    {
        $stmt = $pdo->prepare(
            "insert into global.sessions (id, user_id, token_encrypted, expires_at) values (gen_random_uuid(), :user_id, :token_encrypted, now() + (:ttl || ' seconds')::interval) returning id"
        );
        $stmt->execute([
            ':user_id' => $userId,
            ':token_encrypted' => $tokenEncrypted,
            ':ttl' => (string)$ttlSeconds,
        ]);

        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new RuntimeException('failed to create session');
        }
        return (string)$id;
    }

    /** @return array{user_id: string, token_encrypted: string, expires_at: string} */
    public static function getSession(PDO $pdo, string $sessionId): array
    {
        $stmt = $pdo->prepare('select user_id, token_encrypted, expires_at from global.sessions where id = :id and expires_at > now()');
        $stmt->execute([':id' => $sessionId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new RuntimeException('session not found');
        }
        return [
            'user_id' => is_scalar($row['user_id'] ?? null) ? (string)$row['user_id'] : '',
            'token_encrypted' => is_scalar($row['token_encrypted'] ?? null) ? (string)$row['token_encrypted'] : '',
            'expires_at' => is_scalar($row['expires_at'] ?? null) ? (string)$row['expires_at'] : '',
        ];
    }

    /** @return array{user_id: string, token_encrypted: string, expires_at: string} */
    public static function getSessionForUpdate(PDO $pdo, string $sessionId): array
    {
        if (!$pdo->inTransaction()) {
            throw new RuntimeException('getSessionForUpdate must run inside a transaction');
        }

        $stmt = $pdo->prepare('select user_id, token_encrypted, expires_at from global.sessions where id = :id and expires_at > now() for update');
        $stmt->execute([':id' => $sessionId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new RuntimeException('session not found');
        }
        return [
            'user_id' => is_scalar($row['user_id'] ?? null) ? (string)$row['user_id'] : '',
            'token_encrypted' => is_scalar($row['token_encrypted'] ?? null) ? (string)$row['token_encrypted'] : '',
            'expires_at' => is_scalar($row['expires_at'] ?? null) ? (string)$row['expires_at'] : '',
        ];
    }

    public static function updateSessionTokenEncrypted(PDO $pdo, string $sessionId, string $tokenEncrypted): void
    {
        $stmt = $pdo->prepare('update global.sessions set token_encrypted = :token_encrypted where id = :id');
        $stmt->execute([
            ':id' => $sessionId,
            ':token_encrypted' => $tokenEncrypted,
        ]);
    }

    public static function touchSession(PDO $pdo, string $sessionId): void
    {
        $stmt = $pdo->prepare('update global.sessions set last_seen_at = now() where id = :id');
        $stmt->execute([':id' => $sessionId]);
    }

    public static function deleteSession(PDO $pdo, string $sessionId): void
    {
        if ($sessionId === '') {
            return;
        }
        $stmt = $pdo->prepare('delete from global.sessions where id = :id');
        $stmt->execute([':id' => $sessionId]);
    }
}
