<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.conversations — one user-scoped AI chat thread.
 * Used by both the list endpoint and the export bundling helper.
 */
final readonly class ConversationRow
{
    public function __construct(
        public string $id,
        public string $title,
        public string $model,
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
            model: Row::str($row, 'model'),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     title: string,
     *     model: string,
     *     created_at: string,
     *     updated_at: string,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'model' => $this->model,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
        ];
    }
}
