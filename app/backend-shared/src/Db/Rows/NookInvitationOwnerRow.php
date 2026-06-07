<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * One invitation as seen by the nook owner — projection joins
 * nook_invitations with users to get the inviter's name.
 *
 * Status is derived from accepted_at / declined_at being set
 * (mutually exclusive in practice).
 */
final readonly class NookInvitationOwnerRow
{
    public function __construct(
        public string $id,
        public string $invitedEmail,
        public string $role,
        public string $status,
        public string $inviterName,
        public string $createdAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $accepted = is_scalar($row['accepted_at'] ?? null);
        $declined = is_scalar($row['declined_at'] ?? null);
        $status = $accepted ? 'accepted' : ($declined ? 'declined' : 'pending');

        $first = Row::str($row, 'inviter_first_name');
        $last = Row::str($row, 'inviter_last_name');

        return new self(
            id: Row::str($row, 'id'),
            invitedEmail: Row::str($row, 'invited_email'),
            role: Row::str($row, 'role'),
            status: $status,
            inviterName: trim($first . ' ' . $last),
            createdAt: Row::str($row, 'created_at'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     invited_email: string,
     *     role: string,
     *     status: string,
     *     inviter_name: string,
     *     created_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'invited_email' => $this->invitedEmail,
            'role' => $this->role,
            'status' => $this->status,
            'inviter_name' => $this->inviterName,
            'created_at' => $this->createdAt,
        ];
    }
}
