<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use Throwable;

final class NoteLinksController
{
    private const DEFAULT_RELATES_TO_KEY = 'relates_to';

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $direction = trim($request->queryParam('direction'));
        if ($direction === '') {
            $direction = 'both';
        }
        if (!in_array($direction, ['out', 'in', 'both'], true)) {
            throw new HttpError("direction must be one of out, in, both", 400);
        }

        $noteCheck = $pdo->prepare('select 1 from global.notes where id = :id and nook_id = :nook_id');
        $noteCheck->execute([':id' => $noteId, ':nook_id' => $nookId]);
        if (!$noteCheck->fetchColumn()) {
            throw new HttpError('note not found', 404);
        }

        $where = '';
        if ($direction === 'out') {
            $where = 'and l.source_note_id = :note_id';
        } elseif ($direction === 'in') {
            $where = 'and l.target_note_id = :note_id';
        } else {
            $where = 'and (l.source_note_id = :note_id or l.target_note_id = :note_id)';
        }

        $stmt = $pdo->prepare(
            'select '
            . 'l.id, l.predicate_id, l.source_note_id, l.target_note_id, l.start_date, l.end_date, l.former, l.created_at, l.updated_at, '
            . 'p.key as predicate_key, p.forward_label, p.reverse_label, p.supports_start_date, p.supports_end_date '
            . 'from global.note_links l '
            . 'join global.link_predicates p on p.id = l.predicate_id '
            . 'where l.nook_id = :nook_id ' . $where . ' '
            . 'order by l.created_at desc'
        );
        $stmt->execute([':nook_id' => $nookId, ':note_id' => $noteId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $links = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }

            $former = self::decodeJsonObject($r['former'] ?? null);
            $links[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'predicate_id' => is_scalar($r['predicate_id'] ?? null) ? (string)$r['predicate_id'] : '',
                'predicate_key' => is_scalar($r['predicate_key'] ?? null) ? (string)$r['predicate_key'] : '',
                'forward_label' => is_scalar($r['forward_label'] ?? null) ? (string)$r['forward_label'] : '',
                'reverse_label' => is_scalar($r['reverse_label'] ?? null) ? (string)$r['reverse_label'] : '',
                'supports_start_date' => (bool)($r['supports_start_date'] ?? false),
                'supports_end_date' => (bool)($r['supports_end_date'] ?? false),
                'source_note_id' => is_scalar($r['source_note_id'] ?? null) ? (string)$r['source_note_id'] : '',
                'target_note_id' => is_scalar($r['target_note_id'] ?? null) ? (string)$r['target_note_id'] : '',
                'start_date' => is_scalar($r['start_date'] ?? null) ? (string)$r['start_date'] : '',
                'end_date' => is_scalar($r['end_date'] ?? null) ? (string)$r['end_date'] : '',
                'former' => $former === [] ? (object)[] : $former,
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
            ];
        }

        return JsonResponse::ok(['links' => $links]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $sourceNoteId = trim($request->routeParam('noteId'));
        if ($sourceNoteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($sourceNoteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $data = $request->jsonBody();

        $predicateIdRaw = $data['predicate_id'] ?? '';
        $predicateId = is_string($predicateIdRaw) ? trim($predicateIdRaw) : '';
        if ($predicateId === '') {
            throw new HttpError('predicate_id is required', 400);
        }
        if (!self::isUuid($predicateId)) {
            throw new HttpError('predicate_id must be a UUID', 400);
        }

        $targetNoteIdRaw = $data['target_note_id'] ?? '';
        $targetNoteId = is_string($targetNoteIdRaw) ? trim($targetNoteIdRaw) : '';
        if ($targetNoteId === '') {
            throw new HttpError('target_note_id is required', 400);
        }
        if (!self::isUuid($targetNoteId)) {
            throw new HttpError('target_note_id must be a UUID', 400);
        }
        if ($targetNoteId === $sourceNoteId) {
            throw new HttpError('cannot link a note to itself', 400);
        }

        $startDate = self::normalizeDate($data['start_date'] ?? null);
        $endDate = self::normalizeDate($data['end_date'] ?? null);

        if ($startDate !== '' && $endDate !== '' && $startDate > $endDate) {
            throw new HttpError('start_date must be <= end_date', 400);
        }

        $predStmt = $pdo->prepare(
            'select key, forward_label, reverse_label, supports_start_date, supports_end_date '
            . 'from global.link_predicates where id = :id and nook_id = :nook_id and archived_at is null'
        );
        $predStmt->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $pred = $predStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($pred)) {
            throw new HttpError('predicate not found', 404);
        }

        $supportsStart = (bool)($pred['supports_start_date'] ?? false);
        $supportsEnd = (bool)($pred['supports_end_date'] ?? false);

        if ($startDate !== '' && !$supportsStart) {
            throw new HttpError('predicate does not support start_date', 400);
        }
        if ($endDate !== '' && !$supportsEnd) {
            throw new HttpError('predicate does not support end_date', 400);
        }

        $sourceStmt = $pdo->prepare('select id, type_id from global.notes where id = :id and nook_id = :nook_id');
        $sourceStmt->execute([':id' => $sourceNoteId, ':nook_id' => $nookId]);
        $source = $sourceStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($source)) {
            throw new HttpError('source note not found', 404);
        }

        $targetStmt = $pdo->prepare('select id, type_id from global.notes where id = :id and nook_id = :nook_id');
        $targetStmt->execute([':id' => $targetNoteId, ':nook_id' => $nookId]);
        $target = $targetStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($target)) {
            throw new HttpError('target note not found', 404);
        }

        $sourceTypeId = is_scalar($source['type_id'] ?? null) ? trim((string)$source['type_id']) : '';
        $targetTypeId = is_scalar($target['type_id'] ?? null) ? trim((string)$target['type_id']) : '';

        if (!$this->isPredicateAllowedForTypes($pdo, $nookId, $predicateId, $sourceTypeId, $targetTypeId)) {
            throw new HttpError('predicate not allowed for these note types', 400);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare(
                'insert into global.note_links (nook_id, predicate_id, source_note_id, target_note_id, start_date, end_date) '
                . 'values (:nook_id, :predicate_id, :source_note_id, :target_note_id, :start_date, :end_date) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->execute([
                ':nook_id' => $nookId,
                ':predicate_id' => $predicateId,
                ':source_note_id' => $sourceNoteId,
                ':target_note_id' => $targetNoteId,
                ':start_date' => $startDate !== '' ? $startDate : null,
                ':end_date' => $endDate !== '' ? $endDate : null,
            ]);

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create link', 500);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'link' => [
                    'id' => is_scalar($row['id'] ?? null) ? (string)$row['id'] : '',
                    'nook_id' => $nookId,
                    'predicate_id' => $predicateId,
                    'predicate_key' => is_scalar($pred['key'] ?? null) ? (string)$pred['key'] : '',
                    'forward_label' => is_scalar($pred['forward_label'] ?? null) ? (string)$pred['forward_label'] : '',
                    'reverse_label' => is_scalar($pred['reverse_label'] ?? null) ? (string)$pred['reverse_label'] : '',
                    'supports_start_date' => $supportsStart,
                    'supports_end_date' => $supportsEnd,
                    'source_note_id' => $sourceNoteId,
                    'target_note_id' => $targetNoteId,
                    'start_date' => $startDate,
                    'end_date' => $endDate,
                    'former' => (object)[],
                    'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                    'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $noteId = trim($request->routeParam('noteId'));
        if ($noteId === '') {
            throw new HttpError('noteId is required', 400);
        }
        if (!self::isUuid($noteId)) {
            throw new HttpError('noteId must be a UUID', 400);
        }

        $linkId = trim($request->routeParam('linkId'));
        if ($linkId === '') {
            throw new HttpError('linkId is required', 400);
        }
        if (!self::isUuid($linkId)) {
            throw new HttpError('linkId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'delete from global.note_links '
            . 'where id = :id and nook_id = :nook_id and (source_note_id = :note_id or target_note_id = :note_id) '
            . 'returning id'
        );
        $stmt->execute([':id' => $linkId, ':nook_id' => $nookId, ':note_id' => $noteId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('link not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'link_id' => $linkId,
        ]);
    }

    private function isPredicateAllowedForTypes(PDO $pdo, string $nookId, string $predicateId, string $sourceTypeId, string $targetTypeId): bool
    {
        $stmt = $pdo->prepare(
            'select source_type_id, target_type_id, include_source_subtypes, include_target_subtypes '
            . 'from global.link_predicate_rules where predicate_id = :predicate_id'
        );
        $stmt->execute([':predicate_id' => $predicateId]);
        $rules = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($rules === []) {
            return true;
        }

        foreach ($rules as $r) {
            if (!is_array($r)) {
                continue;
            }

            $ruleSource = is_scalar($r['source_type_id'] ?? null) ? trim((string)$r['source_type_id']) : '';
            $ruleTarget = is_scalar($r['target_type_id'] ?? null) ? trim((string)$r['target_type_id']) : '';
            $incSource = (bool)($r['include_source_subtypes'] ?? true);
            $incTarget = (bool)($r['include_target_subtypes'] ?? true);

            $sourceOk = $this->typeMatchesRule($pdo, $nookId, $sourceTypeId, $ruleSource, $incSource);
            if (!$sourceOk) {
                continue;
            }

            $targetOk = $this->typeMatchesRule($pdo, $nookId, $targetTypeId, $ruleTarget, $incTarget);
            if (!$targetOk) {
                continue;
            }

            return true;
        }

        return false;
    }

    private function typeMatchesRule(PDO $pdo, string $nookId, string $noteTypeId, string $ruleTypeId, bool $includeSubtypes): bool
    {
        if ($ruleTypeId === '') {
            return true;
        }

        if ($noteTypeId === '') {
            return false;
        }

        if (!$includeSubtypes) {
            return $noteTypeId === $ruleTypeId;
        }

        foreach ($this->ancestorTypeIds($pdo, $nookId, $noteTypeId) as $ancestorId) {
            if ($ancestorId === $ruleTypeId) {
                return true;
            }
        }

        return false;
    }

    /** @return array<int, string> */
    private function ancestorTypeIds(PDO $pdo, string $nookId, string $typeId): array
    {
        $seen = [];
        $out = [];

        $current = $typeId;
        while ($current !== '' && !isset($seen[$current])) {
            $seen[$current] = true;
            $out[] = $current;

            $stmt = $pdo->prepare('select parent_id from global.note_types where id = :id and nook_id = :nook_id and archived_at is null');
            $stmt->execute([':id' => $current, ':nook_id' => $nookId]);
            $parentRaw = $stmt->fetchColumn();
            $parent = is_scalar($parentRaw) ? trim((string)$parentRaw) : '';

            if ($parent === '' || !self::isUuid($parent)) {
                break;
            }

            $current = $parent;
        }

        return $out;
    }

    private static function normalizeDate(mixed $value): string
    {
        if ($value === null) {
            return '';
        }
        if (!is_string($value)) {
            throw new HttpError('date must be a string (YYYY-MM-DD)', 400);
        }

        $v = trim($value);
        if ($v === '') {
            return '';
        }

        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) {
            throw new HttpError('date must be in format YYYY-MM-DD', 400);
        }

        return $v;
    }

    /** @return array<string, mixed> */
    private static function decodeJsonObject(mixed $value): array
    {
        if (!is_scalar($value)) {
            return [];
        }
        $decoded = json_decode((string)$value, true);
        if (!is_array($decoded)) {
            return [];
        }
        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    private function ensureDefaultRelatesTo(PDO $pdo, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key and archived_at is null');
        $check->execute([':nook_id' => $nookId, ':key' => self::DEFAULT_RELATES_TO_KEY]);
        if ($check->fetchColumn()) {
            return;
        }

        $stmt = $pdo->prepare(
            'insert into global.link_predicates (nook_id, key, forward_label, reverse_label, supports_start_date, supports_end_date) '
            . 'values (:nook_id, :key, :forward_label, :reverse_label, false, false)'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':key' => self::DEFAULT_RELATES_TO_KEY,
            ':forward_label' => 'relates to',
            ':reverse_label' => 'related to',
        ]);
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): array
    {
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }

        $check = $pdo->prepare('select role from global.nook_members where nook_id = :nook_id and user_id = :user_id limit 1');
        $check->execute([
            ':nook_id' => $nookId,
            ':user_id' => $userId,
        ]);
        $row = $check->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('forbidden', 403);
        }
        return $row;
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
