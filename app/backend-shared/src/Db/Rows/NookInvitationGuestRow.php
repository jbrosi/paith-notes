<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * One pending invitation as seen by the invitee — projection joins
 * nook_invitations with nooks (for the nook name) and users (for
 * the inviter's name). Distinct from NookInvitationOwnerRow because
 * the invitee POV needs the nook context but not the invited email
 * (it's theirs) and doesn't surface declined/accepted status (only
 * pending invites are listed).
 */
final readonly class NookInvitationGuestRow
{
    public function __construct(
        public string $id,
        public string $nookId,
        public string $nookName,
        public string $role,
        public string $inviterName,
        public string $createdAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $first = Row::str($row, 'inviter_first_name');
        $last = Row::str($row, 'inviter_last_name');

        return new self(
            id: Row::str($row, 'id'),
            nookId: Row::str($row, 'nook_id'),
            nookName: Row::str($row, 'nook_name'),
            role: Row::str($row, 'role'),
            inviterName: trim($first . ' ' . $last),
            createdAt: Row::str($row, 'created_at'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     nook_id: string,
     *     nook_name: string,
     *     role: string,
     *     inviter_name: string,
     *     created_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'nook_id' => $this->nookId,
            'nook_name' => $this->nookName,
            'role' => $this->role,
            'inviter_name' => $this->inviterName,
            'created_at' => $this->createdAt,
        ];
    }
}
