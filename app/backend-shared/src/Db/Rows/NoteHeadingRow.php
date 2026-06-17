<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.note_headings — one heading parsed from a note's content.
 *
 * Use NoteHeadingRow::fromRow(...) to hydrate from PDO fetch_assoc, and
 * toArray() when shaping the JSON response.
 */
final readonly class NoteHeadingRow
{
    public function __construct(
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
            level: Row::int($row, 'level'),
            text: Row::str($row, 'text'),
            position: Row::int($row, 'position'),
        );
    }

    /**
     * @return array{level: int, text: string, position: int}
     */
    public function toArray(): array
    {
        return ['level' => $this->level, 'text' => $this->text, 'position' => $this->position];
    }
}
