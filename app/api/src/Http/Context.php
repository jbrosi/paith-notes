<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use PDO;

final class Context
{
    /** @var callable(): PDO */
    private $pdoFactory;

    private ?PDO $pdo;

    private ?array $user;

    private string $actor = 'user';

    /** @param callable(): PDO $pdoFactory */
    public function __construct(callable $pdoFactory)
    {
        $this->pdoFactory = $pdoFactory;
        $this->pdo = null;
        $this->user = null;
    }

    public function pdo(): PDO
    {
        if ($this->pdo instanceof PDO) {
            return $this->pdo;
        }

        $pdo = ($this->pdoFactory)();

        // Set the audit user context for PostgreSQL triggers.
        // If no user is authenticated yet, use a nil UUID (triggers will still fire
        // but the audit row records that no user was identified).
        $userId = is_array($this->user) && is_scalar($this->user['id'] ?? null) ? (string)$this->user['id'] : '00000000-0000-0000-0000-000000000000';
        $quotedUserId = $pdo->quote($userId);
        $pdo->exec("select set_config('app.user_id', " . $quotedUserId . ", false)");
        $pdo->exec("select set_config('app.actor', " . $pdo->quote($this->actor) . ", false)");

        $this->pdo = $pdo;
        return $pdo;
    }

    /**
     * Re-sync the PostgreSQL session variables after user/actor is known.
     * Call this after setUser() if pdo() was already accessed.
     */
    public function syncAuditUser(): void
    {
        if ($this->pdo instanceof PDO && is_array($this->user)) {
            $userId = is_scalar($this->user['id'] ?? null) ? (string)$this->user['id'] : '';
            $this->pdo->exec("select set_config('app.user_id', " . $this->pdo->quote($userId) . ", false)");
            $this->pdo->exec("select set_config('app.actor', " . $this->pdo->quote($this->actor) . ", false)");
        }
    }

    public function setUser(array $user): void
    {
        $this->user = $user;
    }

    public function user(): array
    {
        if (!is_array($this->user)) {
            throw new HttpError('not authenticated', 401);
        }
        return $this->user;
    }

    /**
     * Type-safe accessor for the authenticated user's id.
     * Throws 401 when no user is set (same as user()).
     */
    public function userId(): string
    {
        $user = $this->user();
        $id = $user['id'] ?? null;
        if (!is_scalar($id)) {
            throw new HttpError('not authenticated', 401);
        }
        return (string) $id;
    }

    /** Set the actor ('user' or 'ai') from the X-Nook-Actor header */
    public function setActor(string $actor): void
    {
        $this->actor = in_array($actor, ['user', 'ai'], true) ? $actor : 'user';
        if ($this->pdo instanceof PDO) {
            $this->pdo->exec("select set_config('app.actor', " . $this->pdo->quote($this->actor) . ", false)");
        }
    }

    /** Get the actor for this request */
    public function actor(): string
    {
        return $this->actor;
    }
}
