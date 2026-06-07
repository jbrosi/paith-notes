<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Minimal projection of global.note_links used by the nook export
 * bundle — just the three foreign-key UUIDs plus optional date range.
 *
 * Distinct from the rich link projection in NoteLinksController::list
 * which joins predicate metadata, source/target titles, and audit
 * info; the export resolves those by side-tables in the manifest.
 */
final readonly class NoteLinkExportRow
{
    public function __construct(
        public string $id,
        public string $predicateId,
        public string $sourceNoteId,
        public string $targetNoteId,
        public ?string $startDate,
        public ?string $endDate,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        $start = Row::nullStr($row, 'start_date');
        $end = Row::nullStr($row, 'end_date');

        return new self(
            id: Row::str($row, 'id'),
            predicateId: Row::str($row, 'predicate_id'),
            sourceNoteId: Row::str($row, 'source_note_id'),
            targetNoteId: Row::str($row, 'target_note_id'),
            startDate: ($start === null || $start === '') ? null : $start,
            endDate: ($end === null || $end === '') ? null : $end,
        );
    }

    /**
     * Export entry — omits date fields entirely when null/empty so
     * the bundled JSON stays compact. The `?:` keys in the shape
     * tell phpstan they're optional, matching the caller's contract.
     *
     * @return array{
     *     id: string,
     *     predicate_id: string,
     *     source_note_id: string,
     *     target_note_id: string,
     *     start_date?: string,
     *     end_date?: string,
     * }
     */
    public function toExportEntry(): array
    {
        $entry = [
            'id' => $this->id,
            'predicate_id' => $this->predicateId,
            'source_note_id' => $this->sourceNoteId,
            'target_note_id' => $this->targetNoteId,
        ];
        if ($this->startDate !== null) {
            $entry['start_date'] = $this->startDate;
        }
        if ($this->endDate !== null) {
            $entry['end_date'] = $this->endDate;
        }
        return $entry;
    }
}
