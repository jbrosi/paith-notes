<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.conversation_blocks — one streamed content block
 * (text, tool_use, tool_result, etc.) belonging to a chat turn.
 *
 * `content` is whatever JSON was stored — its shape varies by
 * block_type and is intentionally left as mixed; downstream code
 * re-decodes / re-encodes it without inspecting the inner schema.
 *
 * `turnStartedAt` is the partition min(created_at) over turn_id —
 * present when the list query includes the window expression, empty
 * otherwise.
 */
final readonly class ConversationBlockRow
{
    public function __construct(
        public string $id,
        public string $turnId,
        public string $role,
        public int $blockIndex,
        public string $blockType,
        public mixed $content,
        public ?string $model,
        public string $createdAt,
        public string $turnStartedAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $rawContent = $row['content'] ?? null;
        $content = is_string($rawContent) ? json_decode($rawContent, true) : $rawContent;

        return new self(
            id: Row::str($row, 'id'),
            turnId: Row::str($row, 'turn_id'),
            role: Row::str($row, 'role'),
            blockIndex: Row::int($row, 'block_index'),
            blockType: Row::str($row, 'block_type'),
            content: $content,
            model: Row::nullStr($row, 'model'),
            createdAt: Row::str($row, 'created_at'),
            turnStartedAt: Row::str($row, 'turn_started_at'),
        );
    }

    /**
     * The shape consumed by the bundling/export helper — content
     * stays decoded for re-shaping into Anthropic-style turn structure.
     *
     * @return array{
     *     id: string,
     *     turn_id: string,
     *     role: string,
     *     block_index: int,
     *     block_type: string,
     *     content: mixed,
     *     model: ?string,
     *     created_at: string,
     * }
     */
    public function toBlockArray(): array
    {
        return [
            'id' => $this->id,
            'turn_id' => $this->turnId,
            'role' => $this->role,
            'block_index' => $this->blockIndex,
            'block_type' => $this->blockType,
            'content' => $this->content,
            'model' => $this->model,
            'created_at' => $this->createdAt,
        ];
    }

    /**
     * The effective turn-start timestamp — prefers the window-min
     * column when available, falls back to the block's own
     * created_at.
     */
    public function turnCreatedAt(): string
    {
        return $this->turnStartedAt !== '' ? $this->turnStartedAt : $this->createdAt;
    }
}
