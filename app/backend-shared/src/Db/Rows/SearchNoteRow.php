<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Per-note projection for GET /api/search — the cross-nook variant of
 * the in-nook list row. Adds nook_id + nook_name so the client can
 * render the owning nook beside each hit; reuses the same four
 * mention/link counters as the in-nook list view.
 */
final readonly class SearchNoteRow
{
    public function __construct(
        public string $id,
        public string $title,
        public string $nookId,
        public string $nookName,
        public string $typeId,
        public string $createdAt,
        public int $outgoingMentionsCount,
        public int $incomingMentionsCount,
        public int $outgoingLinksCount,
        public int $incomingLinksCount,
        /** Character count of the note's content. Helps the AI decide
         *  whether a full get_note is worth the context cost vs. a
         *  partial read_note_lines peek. */
        public int $contentChars,
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
            nookId: Row::str($row, 'nook_id'),
            nookName: Row::str($row, 'nook_name'),
            typeId: Row::str($row, 'type_id'),
            createdAt: Row::str($row, 'created_at'),
            outgoingMentionsCount: Row::int($row, 'outgoing_mentions_count'),
            incomingMentionsCount: Row::int($row, 'incoming_mentions_count'),
            outgoingLinksCount: Row::int($row, 'outgoing_links_count'),
            incomingLinksCount: Row::int($row, 'incoming_links_count'),
            contentChars: Row::int($row, 'content_chars'),
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
            'nook_id' => $this->nookId,
            'nook_name' => $this->nookName,
            'type_id' => $this->typeId,
            'outgoing_mentions_count' => $this->outgoingMentionsCount,
            'incoming_mentions_count' => $this->incomingMentionsCount,
            'outgoing_links_count' => $this->outgoingLinksCount,
            'incoming_links_count' => $this->incomingLinksCount,
            'content_chars' => $this->contentChars,
            'created_at' => $this->createdAt,
        ];
    }
}
