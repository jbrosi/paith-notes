<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Minimal user projection — id plus the three fields needed to
 * compose a display name (first/last/username). Used by the nook
 * export to build a `user_id → name` map for "last edited by" lines.
 *
 * displayName() walks a fallback chain: real name → username → id.
 */
final readonly class UserNameRow
{
    public function __construct(
        public string $id,
        public string $firstName,
        public string $lastName,
        public string $username,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            id: Row::str($row, 'id'),
            firstName: Row::str($row, 'first_name'),
            lastName: Row::str($row, 'last_name'),
            username: Row::str($row, 'username'),
        );
    }

    /**
     * Best-effort display name with fallbacks. Returns '' only when
     * the row's own id is also empty (unreachable from the DB).
     */
    public function displayName(): string
    {
        $composed = trim($this->firstName . ' ' . $this->lastName);
        if ($composed !== '') {
            return $composed;
        }
        if ($this->username !== '') {
            return $this->username;
        }
        return $this->id;
    }
}
