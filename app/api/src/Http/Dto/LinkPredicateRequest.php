<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;

/**
 * Validated payload for POST and PUT on /nooks/{nookId}/link-predicates[/{predicateId}].
 *
 * All four text fields are required (`key`, `forward_label`, `reverse_label`
 * — `reverse_label` defaults to forward when empty in some legacy clients;
 * the controller checks). `supports_start_date` and `supports_end_date`
 * are flags that default to false.
 *
 * Reserved-key validation (e.g. blocking "relates_to") stays in the
 * controller — keep policy decisions out of the DTO.
 */
final readonly class LinkPredicateRequest
{
    public function __construct(
        public string $key,
        public string $forwardLabel,
        public string $reverseLabel,
        public bool $supportsStartDate,
        public bool $supportsEndDate,
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
        $forward = JsonReader::optionalTrimmedString($data, 'forward_label');
        if ($forward === '') {
            throw new HttpError('forward_label is required', 400);
        }
        $reverse = JsonReader::optionalTrimmedString($data, 'reverse_label');
        if ($reverse === '') {
            throw new HttpError('reverse_label is required', 400);
        }

        return new self(
            key: $key,
            forwardLabel: $forward,
            reverseLabel: $reverse,
            supportsStartDate: JsonReader::optionalBool($data, 'supports_start_date'),
            supportsEndDate: JsonReader::optionalBool($data, 'supports_end_date'),
        );
    }
}
