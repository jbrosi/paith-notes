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

final class LinkPredicatesController
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

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $stmt = $pdo->prepare(
            'select id, key, forward_label, reverse_label, supports_start_date, supports_end_date, archived_at, created_at, updated_at '
            . 'from global.link_predicates where nook_id = :nook_id and archived_at is null order by key asc'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $predicates = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $predicates[] = [
                'id' => is_scalar($r['id'] ?? null) ? (string)$r['id'] : '',
                'nook_id' => $nookId,
                'key' => is_scalar($r['key'] ?? null) ? (string)$r['key'] : '',
                'forward_label' => is_scalar($r['forward_label'] ?? null) ? (string)$r['forward_label'] : '',
                'reverse_label' => is_scalar($r['reverse_label'] ?? null) ? (string)$r['reverse_label'] : '',
                'supports_start_date' => (bool)($r['supports_start_date'] ?? false),
                'supports_end_date' => (bool)($r['supports_end_date'] ?? false),
                'archived_at' => is_scalar($r['archived_at'] ?? null) ? (string)$r['archived_at'] : '',
                'created_at' => is_scalar($r['created_at'] ?? null) ? (string)$r['created_at'] : '',
                'updated_at' => is_scalar($r['updated_at'] ?? null) ? (string)$r['updated_at'] : '',
            ];
        }

        return JsonResponse::ok(['predicates' => $predicates]);
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

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $data = $request->jsonBody();

        $keyRaw = $data['key'] ?? '';
        $key = is_string($keyRaw) ? trim($keyRaw) : '';
        if ($key === '') {
            throw new HttpError('key is required', 400);
        }
        if ($key === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to is reserved', 400);
        }

        $forwardRaw = $data['forward_label'] ?? '';
        $forward = is_string($forwardRaw) ? trim($forwardRaw) : '';
        if ($forward === '') {
            throw new HttpError('forward_label is required', 400);
        }

        $reverseRaw = $data['reverse_label'] ?? '';
        $reverse = is_string($reverseRaw) ? trim($reverseRaw) : '';
        if ($reverse === '') {
            throw new HttpError('reverse_label is required', 400);
        }

        $supportsStart = (bool)($data['supports_start_date'] ?? false);
        $supportsEnd = (bool)($data['supports_end_date'] ?? false);

        try {
            $pdo->beginTransaction();

            $dupe = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key and archived_at is null');
            $dupe->execute([':nook_id' => $nookId, ':key' => $key]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }

            $stmt = $pdo->prepare(
                'insert into global.link_predicates (nook_id, key, forward_label, reverse_label, supports_start_date, supports_end_date) '
                . 'values (:nook_id, :key, :forward_label, :reverse_label, :supports_start_date, :supports_end_date) '
                . 'returning id, created_at, updated_at'
            );
            $stmt->bindValue(':nook_id', $nookId);
            $stmt->bindValue(':key', $key);
            $stmt->bindValue(':forward_label', $forward);
            $stmt->bindValue(':reverse_label', $reverse);
            $stmt->bindValue(':supports_start_date', $supportsStart, PDO::PARAM_BOOL);
            $stmt->bindValue(':supports_end_date', $supportsEnd, PDO::PARAM_BOOL);
            $stmt->execute();

            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new HttpError('failed to create predicate', 500);
            }

            $pdo->commit();

            $id = is_scalar($row['id'] ?? null) ? (string)$row['id'] : '';

            return JsonResponse::ok([
                'predicate' => [
                    'id' => $id,
                    'nook_id' => $nookId,
                    'key' => $key,
                    'forward_label' => $forward,
                    'reverse_label' => $reverse,
                    'supports_start_date' => $supportsStart,
                    'supports_end_date' => $supportsEnd,
                    'archived_at' => '',
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

    public function update(Request $request, Context $context): Response
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

        $predicateId = trim($request->routeParam('predicateId'));
        if ($predicateId === '') {
            throw new HttpError('predicateId is required', 400);
        }
        if (!self::isUuid($predicateId)) {
            throw new HttpError('predicateId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $keyCheck = $pdo->prepare('select key from global.link_predicates where id = :id and nook_id = :nook_id and archived_at is null');
        $keyCheck->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('predicate not found', 404);
        }
        if ($existingKey === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to cannot be modified', 400);
        }

        $data = $request->jsonBody();

        $keyRaw = $data['key'] ?? '';
        $key = is_string($keyRaw) ? trim($keyRaw) : '';
        if ($key === '') {
            throw new HttpError('key is required', 400);
        }
        if ($key === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to is reserved', 400);
        }

        $forwardRaw = $data['forward_label'] ?? '';
        $forward = is_string($forwardRaw) ? trim($forwardRaw) : '';
        if ($forward === '') {
            throw new HttpError('forward_label is required', 400);
        }

        $reverseRaw = $data['reverse_label'] ?? '';
        $reverse = is_string($reverseRaw) ? trim($reverseRaw) : '';
        if ($reverse === '') {
            throw new HttpError('reverse_label is required', 400);
        }

        $supportsStart = (bool)($data['supports_start_date'] ?? false);
        $supportsEnd = (bool)($data['supports_end_date'] ?? false);

        if ($key !== $existingKey) {
            $dupe = $pdo->prepare('select 1 from global.link_predicates where nook_id = :nook_id and key = :key and id != :id and archived_at is null');
            $dupe->execute([':nook_id' => $nookId, ':key' => $key, ':id' => $predicateId]);
            if ($dupe->fetchColumn()) {
                throw new HttpError('key already exists', 409);
            }
        }

        $stmt = $pdo->prepare(
            'update global.link_predicates set key = :key, forward_label = :forward_label, reverse_label = :reverse_label, supports_start_date = :supports_start_date, supports_end_date = :supports_end_date, updated_at = now() '
            . 'where id = :id and nook_id = :nook_id and archived_at is null '
            . 'returning created_at, updated_at'
        );
        $stmt->bindValue(':id', $predicateId);
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':key', $key);
        $stmt->bindValue(':forward_label', $forward);
        $stmt->bindValue(':reverse_label', $reverse);
        $stmt->bindValue(':supports_start_date', $supportsStart, PDO::PARAM_BOOL);
        $stmt->bindValue(':supports_end_date', $supportsEnd, PDO::PARAM_BOOL);
        $stmt->execute();

        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('predicate not found', 404);
        }

        return JsonResponse::ok([
            'predicate' => [
                'id' => $predicateId,
                'nook_id' => $nookId,
                'key' => $key,
                'forward_label' => $forward,
                'reverse_label' => $reverse,
                'supports_start_date' => $supportsStart,
                'supports_end_date' => $supportsEnd,
                'archived_at' => '',
                'created_at' => is_scalar($row['created_at'] ?? null) ? (string)$row['created_at'] : '',
                'updated_at' => is_scalar($row['updated_at'] ?? null) ? (string)$row['updated_at'] : '',
            ],
        ]);
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

        $predicateId = trim($request->routeParam('predicateId'));
        if ($predicateId === '') {
            throw new HttpError('predicateId is required', 400);
        }
        if (!self::isUuid($predicateId)) {
            throw new HttpError('predicateId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);
        $this->ensureDefaultRelatesTo($pdo, $nookId);

        $keyCheck = $pdo->prepare('select key from global.link_predicates where id = :id and nook_id = :nook_id and archived_at is null');
        $keyCheck->execute([':id' => $predicateId, ':nook_id' => $nookId]);
        $existingKeyRaw = $keyCheck->fetchColumn();
        $existingKey = is_scalar($existingKeyRaw) ? (string)$existingKeyRaw : '';
        if ($existingKey === '') {
            throw new HttpError('predicate not found', 404);
        }
        if ($existingKey === self::DEFAULT_RELATES_TO_KEY) {
            throw new HttpError('relates_to cannot be deleted', 400);
        }

        $stmt = $pdo->prepare(
            'update global.link_predicates set archived_at = now(), updated_at = now() where id = :id and nook_id = :nook_id and archived_at is null returning id'
        );
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $predicateId = trim($request->routeParam('predicateId'));
        if ($predicateId === '') {
            throw new HttpError('predicateId is required', 400);
        }
        if (!self::isUuid($predicateId)) {
            throw new HttpError('predicateId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $check = $pdo->prepare('select 1 from global.link_predicates where id = :id and nook_id = :nook_id and archived_at is null');
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
                'id' => is_scalar($r['id'] ?? null) ? (int)$r['id'] : 0,
                'predicate_id' => $predicateId,
                'source_type_id' => is_scalar($r['source_type_id'] ?? null) ? (string)$r['source_type_id'] : '',
                'target_type_id' => is_scalar($r['target_type_id'] ?? null) ? (string)$r['target_type_id'] : '',
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

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '') {
            throw new HttpError('nookId is required', 400);
        }
        if (!self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $predicateId = trim($request->routeParam('predicateId'));
        if ($predicateId === '') {
            throw new HttpError('predicateId is required', 400);
        }
        if (!self::isUuid($predicateId)) {
            throw new HttpError('predicateId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $check = $pdo->prepare('select 1 from global.link_predicates where id = :id and nook_id = :nook_id and archived_at is null');
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
            if ($sourceTypeId !== '' && !self::isUuid($sourceTypeId)) {
                throw new HttpError('source_type_id must be a UUID', 400);
            }

            $targetTypeIdRaw = $rr['target_type_id'] ?? '';
            $targetTypeId = is_string($targetTypeIdRaw) ? trim($targetTypeIdRaw) : '';
            if ($targetTypeId !== '' && !self::isUuid($targetTypeId)) {
                throw new HttpError('target_type_id must be a UUID', 400);
            }

            if ($sourceTypeId !== '') {
                $t = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id and archived_at is null');
                $t->execute([':id' => $sourceTypeId, ':nook_id' => $nookId]);
                if (!$t->fetchColumn()) {
                    throw new HttpError('source type not found', 404);
                }
            }
            if ($targetTypeId !== '') {
                $t = $pdo->prepare('select 1 from global.note_types where id = :id and nook_id = :nook_id and archived_at is null');
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
