<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller\Export;

/**
 * PHPStan type aliases for the data structures the export pipeline passes
 * around. These describe the shape of the array lookups built by
 * NookExportController and consumed by the renderer classes — using them
 * via `@phpstan-import-type` in the renderers' docblocks gives phpstan
 * concrete types without forcing a runtime DTO refactor.
 *
 * @phpstan-type TypeRow array{
 *     id: string,
 *     key: string,
 *     label: string,
 *     description?: string,
 *     parent_id: string|null,
 *     created_at?: string|null,
 *     attribute_layout?: array<string, mixed>,
 *     config_overrides?: array<string, mixed>
 * }
 *
 * @phpstan-type AttrRow array{
 *     id: string,
 *     type_id: string,
 *     key: string,
 *     name: string,
 *     kind: string,
 *     config: array<string, mixed>|\stdClass,
 *     indexed: bool
 * }
 *
 * @phpstan-type FileRow array{
 *     note_id: string,
 *     object_key: string,
 *     filename: string,
 *     extension: string,
 *     mime_type: string,
 *     filesize: int,
 *     checksum: string,
 *     attribute_id: string|null,
 *     file_version: int
 * }
 *
 * @phpstan-type LinkRow array{
 *     id: string,
 *     predicate_id: string,
 *     source_note_id: string,
 *     target_note_id: string,
 *     start_date?: string,
 *     end_date?: string
 * }
 *
 * @phpstan-type PredRow array{
 *     id: string,
 *     key: string,
 *     forward_label: string,
 *     reverse_label: string,
 *     supports_start_date: bool,
 *     supports_end_date: bool
 * }
 *
 * @phpstan-type NoteLinkSummary array{predicate: string, target_id: string}
 *
 * @phpstan-type Lookups array{
 *     typeById: array<string, TypeRow>,
 *     attrById: array<string, AttrRow>,
 *     attrList: list<AttrRow>,
 *     noteMap: array<string, string>,
 *     noteTitles: array<string, string>,
 *     noteFiles: array<string, list<FileRow>>,
 *     linksBySource: array<string, list<NoteLinkSummary>>,
 *     mentionsBySource: array<string, list<string>>,
 *     userNames: array<string, string>,
 *     lastUpdaters: array<string, string>,
 *     typeFolders: array<string, string>,
 *     appBaseUrl: string
 * }
 *
 * @phpstan-type RenderContext array{
 *     note_id: string,
 *     noteMap: array<string, string>,
 *     noteTitles: array<string, string>,
 *     noteDir: string,
 *     noteFiles: array<string, list<FileRow>>,
 *     attrById: array<string, AttrRow>,
 *     linksBySource: array<string, list<NoteLinkSummary>>,
 *     mentionsBySource: array<string, list<string>>
 * }
 */
final class ExportTypes
{
    // This class exists purely as an anchor for @phpstan-type aliases.
    // Importers use:
    //   @phpstan-import-type Lookups from ExportTypes
}
