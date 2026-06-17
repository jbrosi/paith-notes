<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.link_predicates with timestamps — the shape returned by
 * GET /nooks/{nook}/link-predicates. The nook export controller uses the
 * same DB query but emits only the leading fields; expose properties
 * directly there rather than always serializing the full toArray().
 */
final readonly class LinkPredicateRow
{
    public function __construct(
        public string $id,
        public string $key,
        public string $forwardLabel,
        public string $reverseLabel,
        public bool $supportsStartDate,
        public bool $supportsEndDate,
        public string $createdAt,
        public string $updatedAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            id: Row::str($row, 'id'),
            key: Row::str($row, 'key'),
            forwardLabel: Row::str($row, 'forward_label'),
            reverseLabel: Row::str($row, 'reverse_label'),
            supportsStartDate: Row::bool($row, 'supports_start_date'),
            supportsEndDate: Row::bool($row, 'supports_end_date'),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
        );
    }

    /**
     * Full API response shape — caller layers nook_id on top because
     * it's not selected from the row.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'key' => $this->key,
            'forward_label' => $this->forwardLabel,
            'reverse_label' => $this->reverseLabel,
            'supports_start_date' => $this->supportsStartDate,
            'supports_end_date' => $this->supportsEndDate,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
