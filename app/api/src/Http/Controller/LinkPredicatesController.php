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
use Paith\Notes\Shared\Uuid;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\Dto\LinkPredicateRequest;
use Paith\Notes\Api\Http\Auth\User;

final class LinkPredicatesController
{
    private const DEFAULT_RELATES_TO_KEY = 'relates_to';

    public function list(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $stmt = $pdo->prepare(
            'select id, key, forward_label, reverse_label, supports_start_date, supports_end_date, created_at, updated_at '
            . 'from global.link_predicates where nook_id = :nook_id order by key asc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $predicates = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $predicates[] = [
                'id' => Row::str($r, 'id'),
                'nook_id' => $nookId,
                'key' => Row::str($r, 'key'),
                'forward_label' => Row::str($r, 'forward_label'),
                'reverse_label' => Row::str($r, 'reverse_label'),
                'supports_start_date' => (bool)($r['supports_start_date'] ?? false),
                'supports_end_date' => (bool)($r['supports_end_date'] ?? false),
                'created_at' => Row::str($r, 'created_at'),
                'updated_at' => Row::str($r, 'updated_at'),
            ];
        }

        return JsonResponse::ok(['predicates' => $predicates]);
    }

    public function create(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $payload = LinkPredicateRequest::fromJson($request->jsonBody());

        if ($payload->key === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to is reserved', 400);
        }

        try {
            $pdo->beginTransaction();

            $dupe = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key');
            $dupe->execute([':nook_id' => $nookId, ':key' => $payload->key]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }

            $stmt = $pdo->prepare(
                'insert into global.link_predicates (nook_id, key, forward_label, reverse_label, supports_start_date, supports_end_date) '
                . 'values (:nook_id, :key, :forward_label, :reverse_label, :supports_start_date, :supports_end_date) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':key', $payload->key);
            $stmt->bindValue(':forward_label', $payload->forwardLabel);
            $stmt->bindValue(':reverse_label', $payload->reverseLabel);
            $stmt->bindValue(':supports_start_date', $payload->supportsStartDate, PDO::PARAM_BOOL);
            $stmt->bindValue(':supports_end_date', $payload->supportsEndDate, PDO::PARAM_BOOL);
            $stmt->execute();

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create predicate', 500);
            }

            $pdo->commit();

            return JsonResponse::ok([
                'predicate' => [
                    'id' => Row::str($row, 'id'),
                    'nook_id' => $nookId,
                    'key' => $payload->key,
                    'forward_label' => $payload->forwardLabel,
                    'reverse_label' => $payload->reverseLabel,
                    'supports_start_date' => $payload->supportsStartDate,
                    'supports_end_date' => $payload->supportsEndDate,
                    'created_at' => Row::str($row, 'created_at'),
                    'updated_at' => Row::str($row, 'updated_at'),
                ],
            ]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function update(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $predicateId = $request->requireUuidRouteParam('predicateId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $keyCheck = $pdo->prepare('select key from global.link_predicates where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('predicate not found', 404);
        }
        if ($existingKey === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to cannot be modified', 400);
        }

        $payload = LinkPredicateRequest::fromJson($request->jsonBody());

        if ($payload->key === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to is reserved', 400);
        }

        if ($payload->key !== $existingKey) {
            $dupe = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key and id != :id');
            $dupe->execute([':nook_id' => $nookId, ':key' => $payload->key, ':id' => $predicateId]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }
        }

        $stmt = $pdo->prepare(
            'update global.link_predicates set key = :key, forward_label = :forward_label, reverse_label = :reverse_label, supports_start_date = :supports_start_date, supports_end_date = :supports_end_date, updated_at = now() '
            . 'where id = :id and nook_id = :nook_id '
            . 'returning created_at, updated_at'
        );
        $stmt->bindValue(':id', $predicateId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':key', $payload->key);
        $stmt->bindValue(':forward_label', $payload->forwardLabel);
        $stmt->bindValue(':reverse_label', $payload->reverseLabel);
        $stmt->bindValue(':supports_start_date', $payload->supportsStartDate, PDO::PARAM_BOOL);
        $stmt->bindValue(':supports_end_date', $payload->supportsEndDate, PDO::PARAM_BOOL);
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('predicate not found', 404);
        }

        return JsonResponse::ok([
            'predicate' => [
                'id' => $predicateId,
                'nook_id' => $nookId,
                'key' => $payload->key,
                'forward_label' => $payload->forwardLabel,
                'reverse_label' => $payload->reverseLabel,
                'supports_start_date' => $payload->supportsStartDate,
                'supports_end_date' => $payload->supportsEndDate,
                'created_at' => Row::str($row, 'created_at'),
                'updated_at' => Row::str($row, 'updated_at'),
            ],
        ]);
    }

    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $predicateId = $request->requireUuidRouteParam('predicateId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $keyCheck = $pdo->prepare('select key from global.link_predicates where id = :id and nook_id = :nook_id');
        $keyCheck->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('predicate not found', 404);
        }
        if ($existingKey === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to cannot be deleted', 400);
        }

        $stmt = $pdo->prepare('delete from global.link_predicates where id = :id and nook_id = :nook_id returning id');
        $stmt->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $id = $stmt->fetchColumn();
        if (!is_scalar($id) || (string)$id === '') {
            throw new HttpError('predicate not found', 404);
        }

        return JsonResponse::ok([
            'deleted' => true,
            'predicate_id' => $predicateId,
        ]);
    }

    public function rules(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $predicateId = $request->requireUuidRouteParam('predicateId');

        $this->requireMember($pdo, $user, $nookId);

        $check = $pdo->prepare('select 1 from global.link_predicates where id = :id and nook_id = :nook_id');
        $check->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        if (!$check->fetchColumn()) {
            throw new HttpError('predicate not found', 404);
        }

        $stmt = $pdo->prepare(
            'select id, predicate_id, source_type_id, target_type_id, include_source_subtypes, include_target_subtypes '
            . 'from global.link_predicate_rules where predicate_id = :predicate_id order by id asc'
        );
        $stmt->execute([':predicate_id' => $predicateId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $rules = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $rules[] = [
                'id' => Row::int($r, 'id'),
                'predicate_id' => $predicateId,
                'source_type_id' => Row::str($r, 'source_type_id'),
                'target_type_id' => Row::str($r, 'target_type_id'),
                'include_source_subtypes' => (bool)($r['include_source_subtypes'] ?? true),
                'include_target_subtypes' => (bool)($r['include_target_subtypes'] ?? true),
            ];
        }

        return JsonResponse::ok(['rules' => $rules]);
    }

    public function replaceRules(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');

        $predicateId = $request->requireUuidRouteParam('predicateId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        $check = $pdo->prepare('select 1 from global.link_predicates where id = :id and nook_id = :nook_id');
        $check->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        if (!$check->fetchColumn()) {
            throw new HttpError('predicate not found', 404);
        }

        $data = $request->jsonBody();
        $rulesRaw = $data['rules'] ?? null;
        if (!is_array($rulesRaw)) {
            throw new HttpError('rules must be an array', 400);
        }

        $clean = [];
        foreach ($rulesRaw as $rr) {
            if (!is_array($rr)) {
                continue;
            }

            $sourceTypeIdRaw = $rr['source_type_id'] ?? '';
            $sourceTypeId = is_string($sourceTypeIdRaw) ? trim($sourceTypeIdRaw) : '';
            if ($sourceTypeId !== '' && !Uuid::isValid($sourceTypeId)) {
                throw new HttpError('source_type_id must be a UUID', 400);
            }

            $targetTypeIdRaw = $rr['target_type_id'] ?? '';
            $targetTypeId = is_string($targetTypeIdRaw) ? trim($targetTypeIdRaw) : '';
            if ($targetTypeId !== '' && !Uuid::isValid($targetTypeId)) {
                throw new HttpError('target_type_id must be a UUID', 400);
            }

            if ($sourceTypeId !== '') {
                $t = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
                $t->execute([':id' => $sourceTypeId, ':nook_id' => $nookId]);
                if (!$t->fetchColumn()) {
                    throw new HttpError('source type not found', 404);
                }
            }
            if ($targetTypeId !== '') {
                $t = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id');
                $t->execute([':id' => $targetTypeId, ':nook_id' => $nookId]);
                if (!$t->fetchColumn()) {
                    throw new HttpError('target type not found', 404);
                }
            }

            $clean[] = [
                'source_type_id' => $sourceTypeId,
                'target_type_id' => $targetTypeId,
                'include_source_subtypes' => (bool)($rr['include_source_subtypes'] ?? true),
                'include_target_subtypes' => (bool)($rr['include_target_subtypes'] ?? true),
            ];
        }

        try {
            $pdo->beginTransaction();

            $pdo->prepare('delete from global.link_predicate_rules where predicate_id = :predicate_id')->execute([
                ':predicate_id' => $predicateId,
            ]);

            $ins = $pdo->prepare(
                'insert into global.link_predicate_rules (predicate_id, source_type_id, target_type_id, include_source_subtypes, include_target_subtypes) '
                . 'values (:predicate_id, :source_type_id, :target_type_id, :include_source_subtypes, :include_target_subtypes)'
            );

            foreach ($clean as $c) {
                $ins->bindValue(':predicate_id', $predicateId);
                $ins->bindValue(':source_type_id', $c['source_type_id'] !== '' ? $c['source_type_id'] : null);
                $ins->bindValue(':target_type_id', $c['target_type_id'] !== '' ? $c['target_type_id'] : null);
                $ins->bindValue(':include_source_subtypes', $c['include_source_subtypes'], PDO::PARAM_BOOL);
                $ins->bindValue(':include_target_subtypes', $c['include_target_subtypes'], PDO::PARAM_BOOL);
                $ins->execute();
            }

            $pdo->commit();

            return JsonResponse::ok(['saved' => true]);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    private function ensureDefaultRelatesTo(PDO $pdo, string $nookId): void
    {
        $check = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key');
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

    /** @return array<string, mixed> */
    private function requireMember(PDO $pdo, User $user, string $nookId): array
    {
        $userId = $user->id;
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
        /** @var array<string, mixed> $row */
        return $row;
    }
}
