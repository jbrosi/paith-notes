<?php

declare(strict_types=1);

use Paith\Notes\Shared\Db\GlobalSchema;
use Paith\Notes\Worker\Runner;

beforeEach(function (): void {
    $this->pdo = test_pdo();
    ensure_worker_schema($this->pdo);

    // Create a minimal user and nook for FK constraints
    $this->userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    $this->nookId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';

    $this->pdo->prepare(
        "insert into global.users (id, first_name, last_name) values (:id, 'Test', 'User') on conflict (id) do nothing"
    )->execute([':id' => $this->userId]);

    $this->pdo->prepare(
        "insert into global.nooks (id, name, created_by, owner_id) values (:id, 'Test', :uid, :uid) on conflict (id) do nothing"
    )->execute([':id' => $this->nookId, ':uid' => $this->userId]);
});

test('cleanupExpiredUploads removes expired unfinalized uploads', function (): void {
    $uploadId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';

    $this->pdo->prepare(
        "insert into global.file_uploads (id, created_by, nook_id, temp_object_key, expires_at)
         values (:id, :uid, :nook_id, 'tmp/test-file.bin', now() - interval '1 hour')"
    )->execute([':id' => $uploadId, ':uid' => $this->userId, ':nook_id' => $this->nookId]);

    // Trigger cleanup via the public run-once helper exposed for testing
    Runner::runCleanupOnce($this->pdo);

    $stmt = $this->pdo->prepare('select id from global.file_uploads where id = :id');
    $stmt->execute([':id' => $uploadId]);
    expect($stmt->fetch())->toBeFalse();
});

test('cleanupExpiredUploads does not remove uploads that are not yet expired', function (): void {
    $uploadId = 'bbbbbbbb-cccc-4ddd-8eee-000000000002';

    $this->pdo->prepare(
        "insert into global.file_uploads (id, created_by, nook_id, temp_object_key, expires_at)
         values (:id, :uid, :nook_id, 'tmp/fresh-file.bin', now() + interval '10 minutes')"
    )->execute([':id' => $uploadId, ':uid' => $this->userId, ':nook_id' => $this->nookId]);

    Runner::runCleanupOnce($this->pdo);

    $stmt = $this->pdo->prepare('select id from global.file_uploads where id = :id');
    $stmt->execute([':id' => $uploadId]);
    expect($stmt->fetch())->not->toBeFalse();
});

test('cleanupExpiredUploads does not remove finalized uploads', function (): void {
    $uploadId = 'bbbbbbbb-cccc-4ddd-8eee-000000000003';

    $this->pdo->prepare(
        "insert into global.file_uploads (id, created_by, nook_id, temp_object_key, expires_at, finalized_at)
         values (:id, :uid, :nook_id, 'tmp/done-file.bin', now() - interval '1 hour', now())"
    )->execute([':id' => $uploadId, ':uid' => $this->userId, ':nook_id' => $this->nookId]);

    Runner::runCleanupOnce($this->pdo);

    $stmt = $this->pdo->prepare('select id from global.file_uploads where id = :id');
    $stmt->execute([':id' => $uploadId]);
    expect($stmt->fetch())->not->toBeFalse();
});

test('cleanupExpiredUploads does not remove uploads with non-tmp object keys', function (): void {
    $uploadId = 'bbbbbbbb-cccc-4ddd-8eee-000000000004';

    $this->pdo->prepare(
        "insert into global.file_uploads (id, created_by, nook_id, temp_object_key, expires_at)
         values (:id, :uid, :nook_id, 'notes/some-file.bin', now() - interval '1 hour')"
    )->execute([':id' => $uploadId, ':uid' => $this->userId, ':nook_id' => $this->nookId]);

    Runner::runCleanupOnce($this->pdo);

    $stmt = $this->pdo->prepare('select id from global.file_uploads where id = :id');
    $stmt->execute([':id' => $uploadId]);
    expect($stmt->fetch())->not->toBeFalse();
});
