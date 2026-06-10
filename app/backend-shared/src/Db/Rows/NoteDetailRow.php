<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Projection for GET /nooks/{nook}/notes/{note} — full note with
 * content, attributes, archive, audit columns, and the joined
 * creator's display name.
 *
 * The DTO only covers fields drawn from the notes-row query. View
 * count, attached files, headings, and the optional `section` slice
 * are joined in by the controller and not modelled here.
 */
final readonly class NoteDetailRow
{
    /**
     * @param array<string, mixed> $attributes
     * @param array<string, mixed> $archive
     */
    public function __construct(
        public string $id,
        public string $title,
        public string $content,
        public string $typeId,
        public array $attributes,
        public array $archive,
        public int $version,
        public string $createdAt,
        public string $updatedAt,
        public string $createdByName,
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
            content: Row::str($row, 'content'),
            typeId: Row::str($row, 'type_id'),
            attributes: Row::decodeJsonObject($row['attributes'] ?? null),
            archive: Row::decodeJsonObject($row['archive'] ?? null),
            version: Row::int($row, 'version'),
            createdAt: Row::str($row, 'created_at'),
            updatedAt: Row::str($row, 'updated_at'),
            createdByName: Row::str($row, 'created_by_name'),
        );
    }

    /**
     * Serialize the DB-derived fields of the note for the JSON
     * response. The controller adds nook_id, view_count, files,
     * headings, and (optionally) section on top.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'content' => $this->content,
            'type_id' => $this->typeId,
            // Empty maps must serialize as `{}` not `[]`, hence the cast.
            'attributes' => $this->attributes === [] ? (object)[] : $this->attributes,
            'archive' => $this->archive === [] ? (object)[] : $this->archive,
            'version' => $this->version,
            'created_at' => $this->createdAt,
            'updated_at' => $this->updatedAt,
            'created_by_name' => $this->createdByName,
        ];
    }
}
