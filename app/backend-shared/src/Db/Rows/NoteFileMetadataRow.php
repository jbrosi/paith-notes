<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.note_files — the file metadata attached to one
 * file-typed attribute on a note. Used in both GET /notes/{id}
 * (keyed by attribute_id for the client) and the nook export
 * (flat list, includes note_id for cross-linking).
 *
 * fileVersion defaults to 1 because legacy rows predating the
 * version column have nulls in storage.
 */
final readonly class NoteFileMetadataRow
{
    public function __construct(
        public string $noteId,
        public ?string $attributeId,
        public string $objectKey,
        public string $filename,
        public string $extension,
        public int $filesize,
        public string $mimeType,
        public string $checksum,
        public int $fileVersion,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            noteId: Row::str($row, 'note_id'),
            attributeId: Row::nullStr($row, 'attribute_id'),
            objectKey: Row::str($row, 'object_key'),
            filename: Row::str($row, 'filename'),
            extension: Row::str($row, 'extension'),
            filesize: Row::int($row, 'filesize'),
            mimeType: Row::str($row, 'mime_type'),
            checksum: Row::str($row, 'checksum'),
            fileVersion: Row::int($row, 'file_version', 1),
        );
    }

    /**
     * The shape returned per-file inside the note detail response,
     * keyed by attribute_id by the caller (so note_id and attribute_id
     * are not repeated here).
     *
     * @return array{
     *     filename: string,
     *     extension: string,
     *     filesize: int,
     *     mime_type: string,
     *     checksum: string,
     *     file_version: int,
     *     object_key: string,
     * }
     */
    public function toNoteDetailEntry(): array
    {
        return [
            'filename' => $this->filename,
            'extension' => $this->extension,
            'filesize' => $this->filesize,
            'mime_type' => $this->mimeType,
            'checksum' => $this->checksum,
            'file_version' => $this->fileVersion,
            'object_key' => $this->objectKey,
        ];
    }

    /**
     * The flat per-file shape used inside the nook export bundle.
     *
     * @return array{
     *     note_id: string,
     *     object_key: string,
     *     filename: string,
     *     extension: string,
     *     mime_type: string,
     *     filesize: int,
     *     checksum: string,
     *     attribute_id: string|null,
     *     file_version: int,
     * }
     */
    public function toExportEntry(): array
    {
        return [
            'note_id' => $this->noteId,
            'object_key' => $this->objectKey,
            'filename' => $this->filename,
            'extension' => $this->extension,
            'mime_type' => $this->mimeType,
            'filesize' => $this->filesize,
            'checksum' => $this->checksum,
            'attribute_id' => $this->attributeId,
            'file_version' => $this->fileVersion,
        ];
    }
}
