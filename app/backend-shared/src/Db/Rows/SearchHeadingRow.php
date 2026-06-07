<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * One heading match returned by GET /api/search.
 * Distinct from NoteHeadingRow (which models the in-note TOC) because
 * the search response also needs the owning note's title plus the
 * cross-nook context (nook_id + nook_name).
 */
final readonly class SearchHeadingRow
{
    public function __construct(
        public string $noteId,
        public string $nookId,
        public string $nookName,
        public string $noteTitle,
        public int $level,
        public string $text,
        public int $position,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            noteId: Row::str($row, 'note_id'),
            nookId: Row::str($row, 'nook_id'),
            nookName: Row::str($row, 'nook_name'),
            noteTitle: Row::str($row, 'note_title'),
            level: Row::int($row, 'level'),
            text: Row::str($row, 'text'),
            position: Row::int($row, 'position'),
        );
    }

    /**
     * @return array{
     *     note_id: string,
     *     nook_id: string,
     *     nook_name: string,
     *     note_title: string,
     *     level: int,
     *     text: string,
     *     position: int,
     * }
     */
    public function toArray(): array
    {
        return [
            'note_id' => $this->noteId,
            'nook_id' => $this->nookId,
            'nook_name' => $this->nookName,
            'note_title' => $this->noteTitle,
            'level' => $this->level,
            'text' => $this->text,
            'position' => $this->position,
        ];
    }
}
