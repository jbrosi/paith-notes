<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.note_types with timestamps — full projection used by
 * GET /nooks/{nook}/note-types. The nook export reuses the same query
 * but emits a subset and applies its own "omit empty layout/overrides"
 * rule — access properties directly there rather than toArray().
 *
 * attributeLayout is the per-type ordered list of attribute groupings
 * (`[]` when the type hasn't customized it); configOverrides are the
 * type's overrides for inherited attribute configs (`[]` when none).
 */
final readonly class NoteTypeRow
{
    /**
     * @param array<string, mixed> $attributeLayout
     * @param array<string, mixed> $configOverrides
     */
    public function __construct(
        public string $id,
        public string $key,
        public string $label,
        public string $description,
        public string $parentId,
        public array $attributeLayout,
        public array $configOverrides,
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
            label: Row::str($row, 'label'),
            description: Row::str($row, 'description'),
            parentId: Row::str($row, 'parent_id'),
            attributeLayout: Row::decodeJsonObject($row['attribute_layout'] ?? null),
            configOverrides: Row::decodeJsonObject($row['config_overrides'] ?? null),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
        );
    }

    /**
     * API list response shape for /note-types. Caller layers nook_id
     * (not selected from the row) and attaches the per-type attribute
     * list separately.
     *
     * - attribute_layout: null when empty (frontend distinguishes
     *   "no layout set" vs "empty layout")
     * - config_overrides: `{}` when empty (object, not list)
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'key' => $this->key,
            'label' => $this->label,
            'description' => $this->description,
            'parent_id' => $this->parentId,
            'attribute_layout' => $this->attributeLayout === [] ? null : $this->attributeLayout,
            'config_overrides' => $this->configOverrides === [] ? (object)[] : $this->configOverrides,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
