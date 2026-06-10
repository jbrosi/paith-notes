<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;

/**
 * Validated payload for POST /nooks/{nookId}/notes.
 *
 * `fromJson()` is the only constructor path that should be reached from
 * a controller — it throws HttpError 400 on validation failure and
 * returns a fully typed object the controller can pass around.
 */
final readonly class CreateNoteRequest
{
    /**
     * @param array<string, mixed> $attributes  Raw attribute values keyed by attribute UUID
     */
    public function __construct(
        public string $title,
        public string $content,
        public ?string $typeId,
        public array $attributes,
    ) {
    }

    /**
     * @param array<string, mixed> $data  Output of Request::jsonBody()
     */
    public static function fromJson(array $data): self
    {
        $title = JsonReader::optionalTrimmedString($data, 'title');
        if ($title === '') {
            throw new HttpError('title is required', 400);
        }

        return new self(
            title: $title,
            content: JsonReader::optionalString($data, 'content'),
            typeId: JsonReader::optionalUuid($data, 'type_id'),
            attributes: JsonReader::optionalAssoc($data, 'attributes'),
        );
    }
}
