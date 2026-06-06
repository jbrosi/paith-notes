<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Shared\Uuid;

/**
 * Validated payload for PUT /nooks/{nookId}/notes/{noteId}.
 *
 * Update semantics are subtle — every field is optional, and the
 * controller's merge logic depends on knowing whether a field was
 * present in the request at all. So this DTO carries `*Provided`
 * flags alongside the parsed values:
 *
 *   - title: empty string is treated as "not provided" because the
 *     controller falls back to the existing title in that case.
 *     A non-empty string replaces.
 *   - content: when provided, replaces (empty string is valid).
 *   - typeId: tri-state. Not provided → leave alone. Provided as null
 *     / empty string → clear (set type_id to NULL). Provided as a
 *     UUID → set. Provided as something else → 400.
 *   - attributes: when provided, a string-keyed map of attribute UUIDs
 *     to new values. Values of `null` are deletions; other values
 *     replace. When not provided, attributes are left untouched.
 *   - expectedVersion: when provided, the controller does an
 *     optimistic-lock check before writing.
 */
final readonly class UpdateNoteRequest
{
    /**
     * @param array<string, mixed>|null $attributes
     */
    public function __construct(
        public ?string $title,
        public ?string $content,
        public bool $typeIdProvided,
        public ?string $typeId,
        public ?array $attributes,
        public ?int $expectedVersion,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromJson(array $data): self
    {
        $title = null;
        if (isset($data['title']) && is_string($data['title'])) {
            $trimmed = trim($data['title']);
            if ($trimmed !== '') {
                $title = $trimmed;
            }
        }

        $content = null;
        if (isset($data['content']) && is_string($data['content'])) {
            $content = $data['content'];
        }

        $typeIdProvided = array_key_exists('type_id', $data);
        $typeId = null;
        if ($typeIdProvided) {
            $raw = $data['type_id'];
            if (is_string($raw)) {
                $trimmed = trim($raw);
                if ($trimmed !== '') {
                    if (!Uuid::isValid($trimmed)) {
                        throw new HttpError('type_id must be a UUID', 400);
                    }
                    $typeId = $trimmed;
                }
            }
            // raw null or anything non-string with the field present → typeId stays null = "clear"
        }

        $attributes = null;
        if (isset($data['attributes']) && is_array($data['attributes'])) {
            $attributes = [];
            foreach ($data['attributes'] as $k => $v) {
                if (is_string($k)) {
                    $attributes[$k] = $v;
                }
            }
        }

        $expectedVersion = null;
        if (isset($data['expected_version']) && is_numeric($data['expected_version'])) {
            $expectedVersion = (int) $data['expected_version'];
        }

        return new self($title, $content, $typeIdProvided, $typeId, $attributes, $expectedVersion);
    }
}
