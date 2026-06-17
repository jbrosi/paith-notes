<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db\Rows;

use Paith\Notes\Shared\Db\Row;

/**
 * Row from global.link_predicate_rules — one source/target type
 * constraint on a link predicate. Used by both the rule-list API
 * and the nook export bundle.
 *
 * source/target type ids are nullable in the schema (null = "any
 * type allowed"). The two `include_*_subtypes` flags default to
 * true because rules created before that column existed should be
 * treated as inclusive.
 */
final readonly class LinkPredicateRuleRow
{
    public function __construct(
        public int $id,
        public string $predicateId,
        public ?string $sourceTypeId,
        public ?string $targetTypeId,
        public bool $includeSourceSubtypes,
        public bool $includeTargetSubtypes,
    ) {
    }

    /**
     * @param array<array-key, mixed> $row
     */
    public static function fromRow(array $row): self
    {
        return new self(
            id: Row::int($row, 'id'),
            predicateId: Row::str($row, 'predicate_id'),
            sourceTypeId: Row::nullStr($row, 'source_type_id'),
            targetTypeId: Row::nullStr($row, 'target_type_id'),
            includeSourceSubtypes: Row::bool($row, 'include_source_subtypes', true),
            includeTargetSubtypes: Row::bool($row, 'include_target_subtypes', true),
        );
    }

    /**
     * API list-rules response shape — `id` and `predicate_id` are
     * present; nullable type ids serialize as '' for the frontend's
     * "no type constraint" UI.
     *
     * @return array{
     *     id: int,
     *     predicate_id: string,
     *     source_type_id: string,
     *     target_type_id: string,
     *     include_source_subtypes: bool,
     *     include_target_subtypes: bool,
     * }
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'predicate_id' => $this->predicateId,
            'source_type_id' => $this->sourceTypeId ?? '',
            'target_type_id' => $this->targetTypeId ?? '',
            'include_source_subtypes' => $this->includeSourceSubtypes,
            'include_target_subtypes' => $this->includeTargetSubtypes,
        ];
    }

    /**
     * Nook export entry — drops the surrogate `id`; preserves nulls
     * for the type ids so importers can distinguish "any" from a
     * specific empty-string type.
     *
     * @return array{
     *     predicate_id: string,
     *     source_type_id: string|null,
     *     target_type_id: string|null,
     *     include_source_subtypes: bool,
     *     include_target_subtypes: bool,
     * }
     */
    public function toExportEntry(): array
    {
        return [
            'predicate_id' => $this->predicateId,
            'source_type_id' => $this->sourceTypeId,
            'target_type_id' => $this->targetTypeId,
            'include_source_subtypes' => $this->includeSourceSubtypes,
            'include_target_subtypes' => $this->includeTargetSubtypes,
        ];
    }
}
