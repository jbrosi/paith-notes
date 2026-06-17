<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Per-note projection for the in-nook note list — covers
 * GET /nooks/{nook}/notes and similar listings that need light metadata
 * plus the four mention/link counters but not content or attributes.
 */
final readonly class NoteListRow
{
    public function __construct(
        public string $id,
        public string $title,
        public string $typeId,
        public string $createdAt,
        public int $outgoingMentionsCount,
        public int $incomingMentionsCount,
        public int $outgoingLinksCount,
        public int $incomingLinksCount,
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
            createdAt: Row::str($row, 'created_at'),
            outgoingMentionsCount: Row::int($row, 'outgoing_mentions_count'),
            incomingMentionsCount: Row::int($row, 'incoming_mentions_count'),
            outgoingLinksCount: Row::int($row, 'outgoing_links_count'),
            incomingLinksCount: Row::int($row, 'incoming_links_count'),
        );
    }

    /**
     * @return array{
     *     id: string,
     *     title: string,
     *     type_id: string,
     *     created_at: string,
     *     outgoing_mentions_count: int,
     *     incoming_mentions_count: int,
     *     outgoing_links_count: int,
     *     incoming_links_count: int,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'type_id' => $this->typeId,
            'created_at' => $this->createdAt,
            'outgoing_mentions_count' => $this->outgoingMentionsCount,
            'incoming_mentions_count' => $this->incomingMentionsCount,
            'outgoing_links_count' => $this->outgoingLinksCount,
            'incoming_links_count' => $this->incomingLinksCount,
        ];
    }
}
