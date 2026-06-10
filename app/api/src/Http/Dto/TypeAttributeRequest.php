<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;

/**
 * Validated payload for POST and PUT on
 *   /nooks/{nookId}/note-types/{typeId}/attributes[/{attributeId}].
 *
 * `name` and `kind` are required. `kind` must be one of the controller's
 * supported set — the list is passed in from the caller rather than
 * duplicated here, so it stays the source of truth.
 *
 * `keyRaw` carries the user-supplied key (or null); the controller is
 * responsible for slug-from-name when null, and for `indexed` handling.
 */
final readonly class TypeAttributeRequest
{
    /**
     * @param array<string, mixed> $config
     */
    public function __construct(
        public string $name,
        public string $kind,
        public array $config,
        public bool $indexed,
        public ?string $keyRaw,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     * @param list<string>         $validKinds
     */
    public static function fromJson(array $data, array $validKinds): self
    {
        $name = JsonReader::requireString($data, 'name');
        $kind = JsonReader::requireString($data, 'kind');
        if (!in_array($kind, $validKinds, true)) {
            throw new HttpError('kind must be one of: ' . implode(', ', $validKinds), 400);
        }

        $config = JsonReader::optionalAssoc($data, 'config');
        $indexed = isset($data['indexed']) && $data['indexed'] === true;

        $keyRaw = null;
        if (isset($data['key']) && is_string($data['key'])) {
            $trimmed = trim($data['key']);
            if ($trimmed !== '') {
                $keyRaw = $trimmed;
            }
        }

        return new self($name, $kind, $config, $indexed, $keyRaw);
    }
}
