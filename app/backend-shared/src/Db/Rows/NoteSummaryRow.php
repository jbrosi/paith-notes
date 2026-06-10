<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Projection for GET /nooks/{nook}/notes/{note}/summary — the
 * lightweight metadata variant used by AI tooling. No content,
 * no archive, no creator-name join.
 */
final readonly class NoteSummaryRow
{
    /**
     * @param array<string, mixed> $attributes
     */
    public function __construct(
        public string $id,
        public string $title,
        public string $typeId,
        public array $attributes,
        public int $version,
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
            title: Row::str($row, 'title'),
            typeId: Row::str($row, 'type_id'),
            attributes: Row::decodeJsonObject($row['attributes'] ?? null),
            version: Row::int($row, 'version'),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'type_id' => $this->typeId,
            'attributes' => $this->attributes === [] ? (object)[] : $this->attributes,
            'version' => $this->version,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
