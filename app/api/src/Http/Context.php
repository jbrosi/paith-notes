<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use PDO;

final class Context
{
    private $pdoFactory;

    private ?PDO $pdo;

    private ?array $user;

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
        if (!$pdo instanceof PDO) {
            throw new HttpError('PDO factory did not return a PDO instance', 500);
        }

        $this->pdo = $pdo;
        return $pdo;
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
}
