<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * One access-revocation notice as seen by the former member.
 * The nook name is denormalized into the revocation row itself
 * (the user may have lost access to the nook by the time they see
 * the notice), so this DTO doesn't join nooks; it only joins users
 * to get the revoker's display name.
 */
final readonly class NookRevocationRow
{
    public function __construct(
        public string $id,
        public string $nookName,
        public string $revokedByName,
        public string $createdAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $first = Row::str($row, 'revoker_first_name');
        $last = Row::str($row, 'revoker_last_name');

        return new self(
            id: Row::str($row, 'id'),
            nookName: Row::str($row, 'nook_name'),
            revokedByName: trim($first . ' ' . $last),
            createdAt: Row::str($row, 'created_at'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     nook_name: string,
     *     revoked_by_name: string,
     *     created_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'nook_name' => $this->nookName,
            'revoked_by_name' => $this->revokedByName,
            'created_at' => $this->createdAt,
        ];
    }
}
