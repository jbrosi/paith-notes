<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Shared\Uuid;

/**
 * Validated payload for POST /nooks/{nookId}/note-types and the
 * matching PUT /nooks/{nookId}/note-types/{typeId} endpoint.
 *
 * Both shapes require `key` and `label`. `attribute_layout` and
 * `config_overrides` are update-only: they're parsed when present and
 * left as null otherwise — the controller decides whether to use them.
 *
 * Structural validation for `attribute_layout` (panel shape, attribute
 * lists, etc.) stays in NoteTypesController; this DTO only does the
 * "is it a string-keyed array" narrowing.
 */
final readonly class NoteTypeRequest
{
    /**
     * @param array<string, mixed>|null $attributeLayout
     * @param array<string, mixed>|null $configOverrides
     */
    public function __construct(
        public string $key,
        public string $label,
        public string $description,
        public ?string $parentId,
        public ?array $attributeLayout,
        public ?array $configOverrides,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromJson(array $data): self
    {
        $key = JsonReader::optionalTrimmedString($data, 'key');
        if ($key === '') {
            throw new HttpError('key is required', 400);
        }
        $label = JsonReader::optionalTrimmedString($data, 'label');
        if ($label === '') {
            throw new HttpError('label is required', 400);
        }
        $description = JsonReader::optionalString($data, 'description');

        $parentId = JsonReader::optionalTrimmedString($data, 'parent_id');
        $parentIdOrNull = null;
        if ($parentId !== '') {
            if (!Uuid::isValid($parentId)) {
                throw new HttpError('parent_id must be a UUID', 400);
            }
            $parentIdOrNull = $parentId;
        }

        $attributeLayout = null;
        if (isset($data['attribute_layout']) && is_array($data['attribute_layout'])) {
            $attributeLayout = [];
            foreach ($data['attribute_layout'] as $k => $v) {
                if (is_string($k)) {
                    $attributeLayout[$k] = $v;
                }
            }
        }

        $configOverrides = null;
        if (isset($data['config_overrides']) && is_array($data['config_overrides'])) {
            $configOverrides = [];
            foreach ($data['config_overrides'] as $k => $v) {
                if (is_string($k)) {
                    $configOverrides[$k] = $v;
                }
            }
        }

        return new self($key, $label, $description, $parentIdOrNull, $attributeLayout, $configOverrides);
    }
}
