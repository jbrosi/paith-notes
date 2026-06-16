<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Shared\Uuid;

/**
 * Validated payload for POST /nooks/{nookId}/notes/{noteId}/links.
 *
 * Predicate and target are required UUIDs. start_date and end_date
 * accept YYYY-MM-DD or empty/missing (treated as null). The DTO
 * enforces start <= end; the controller still has to verify the
 * predicate exists, that it supports dates, and that target ≠ source.
 */
final readonly class CreateNoteLinkRequest
{
    public function __construct(
        public string $predicateId,
        public string $targetNoteId,
        public ?string $startDate,
        public ?string $endDate,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromJson(array $data): self
    {
        $predicateId = JsonReader::optionalTrimmedString($data, 'predicate_id');
        if ($predicateId === '') {
            throw new HttpError('predicate_id is required', 400);
        }
        if (!Uuid::isValid($predicateId)) {
            throw new HttpError('predicate_id must be a UUID', 400);
        }

        $targetNoteId = JsonReader::optionalTrimmedString($data, 'target_note_id');
        if ($targetNoteId === '') {
            throw new HttpError('target_note_id is required', 400);
        }
        if (!Uuid::isValid($targetNoteId)) {
            throw new HttpError('target_note_id must be a UUID', 400);
        }

        $start = self::normalizeDate($data['start_date'] ?? null);
        $end = self::normalizeDate($data['end_date'] ?? null);
        if ($start !== null && $end !== null && $start > $end) {
            throw new HttpError('start_date must be <= end_date', 400);
        }

        return new self($predicateId, $targetNoteId, $start, $end);
    }

    private static function normalizeDate(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $v = trim($value);
        if ($v === '') {
            return null;
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) !== 1) {
            throw new HttpError('date must be in format YYYY-MM-DD', 400);
        }
        return $v;
    }
}
