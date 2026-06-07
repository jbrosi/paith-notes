<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.type_attributes — one attribute schema entry on a
 * note type. Used by GET /nooks/{nook}/note-types (grouped by type_id)
 * and the nook export bundle.
 *
 * `config` is the kind-specific config blob (e.g. enum options, date
 * format); `indexed` is whether the attribute participates in the
 * attribute-search index.
 */
final readonly class TypeAttributeRow
{
    /**
     * @param array<string, mixed> $config
     */
    public function __construct(
        public string $id,
        public string $typeId,
        public string $name,
        public string $key,
        public string $kind,
        public array $config,
        public bool $indexed,
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
            typeId: Row::str($row, 'type_id'),
            name: Row::str($row, 'name'),
            key: Row::str($row, 'key'),
            kind: Row::str($row, 'kind'),
            config: Row::decodeJsonObject($row['config'] ?? null),
            indexed: Row::bool($row, 'indexed'),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
        );
    }

    /**
     * API response shape — caller decides how to group by type_id.
     * config is wrapped as `{}` when empty for stable JSON object shape.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'type_id' => $this->typeId,
            'name' => $this->name,
            'key' => $this->key,
            'kind' => $this->kind,
            'config' => $this->config === [] ? (object)[] : $this->config,
            'indexed' => $this->indexed,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
