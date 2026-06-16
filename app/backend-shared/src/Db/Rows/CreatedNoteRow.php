<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Minimal projection of the columns returned from
 *   INSERT INTO global.notes ... RETURNING id, created_at
 *
 * Use `CreatedNoteRow::fromRow(...)` instead of poking at the array
 * directly so the controller never deals with mixed-typed cells.
 */
final readonly class CreatedNoteRow
{
    public function __construct(
        public string $id,
        public string $createdAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            id: Row::requireStr($row, 'id'),
            createdAt: Row::requireStr($row, 'created_at'),
        );
    }
}
