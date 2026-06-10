<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * One member of a nook from the owner's POV — joins nook_members
 * with users for the display name + email; `joined_at` comes from
 * the membership row's created_at, not the user's.
 */
final readonly class NookMemberRow
{
    public function __construct(
        public string $id,
        public string $name,
        public string $email,
        public string $role,
        public string $joinedAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $first = Row::str($row, 'first_name');
        $last = Row::str($row, 'last_name');

        return new self(
            id: Row::str($row, 'id'),
            name: trim($first . ' ' . $last),
            email: Row::str($row, 'email'),
            role: Row::str($row, 'role'),
            joinedAt: Row::str($row, 'created_at'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     name: string,
     *     email: string,
     *     role: string,
     *     joined_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'role' => $this->role,
            'joined_at' => $this->joinedAt,
        ];
    }
}
