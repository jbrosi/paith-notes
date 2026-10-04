<?php

declare(strict_types=1);

use Paith\Notes\Worker\Runner;

/*
 * The chat-attachment reaper: it deletes FILES, so every test here is really
 * about what it must NOT delete. A reaper that removes a live attachment is an
 * unrecoverable data-loss bug; a reaper that does nothing is merely untidy.
 *
 * Runs against a temp FILES_DATA_PATH so it never touches the real /data.
 */

const REAP_ROOT = '/tmp/paith-orphan-reaper-test';

$savedFilesDataPath = null;

/** Write a chat attachment file, backdated past the grace period by default. */
function reapWriteAttachment(string $convId, string $name, bool $aged = true): string
{
    $dir = REAP_ROOT . '/chat/' . $convId . '/images';
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    $path = $dir . '/' . $name;
    file_put_contents($path, 'fake-bytes');
    if ($aged) {
        touch($path, time() - 7200);
    }
    return $path;
}

function reapObjectKey(string $convId, string $name): string
{
    return 'chat/' . $convId . '/images/' . $name;
}

beforeEach(function () use (&$savedFilesDataPath): void {
    $savedFilesDataPath = getenv('FILES_DATA_PATH');
    putenv('FILES_DATA_PATH=' . REAP_ROOT);

    if (is_dir(REAP_ROOT)) {
        $it = new RecursiveDirectoryIterator(REAP_ROOT, RecursiveDirectoryIterator::SKIP_DOTS);
        $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
    }

    $this->pdo = test_pdo();
    ensure_worker_schema($this->pdo);

    $this->userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011';
    $this->convId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000012';

    $this->pdo->exec('delete from global.conversation_images');
    $this->pdo->exec('delete from global.conversations');
    $this->pdo->prepare(
        "insert into global.users (id, first_name, last_name) values (:id, 'Reap', 'Tester')
         on conflict (id) do nothing"
    )->execute([':id' => $this->userId]);
    $this->pdo->prepare(
        "insert into global.conversations (id, user_id, title, model)
         values (:id, :uid, 'Reap', 'paith-high')
         on conflict (id) do nothing"
    )->execute([':id' => $this->convId, ':uid' => $this->userId]);
});

afterEach(function () use (&$savedFilesDataPath): void {
    if ($savedFilesDataPath === false) {
        putenv('FILES_DATA_PATH');
    } else {
        putenv('FILES_DATA_PATH=' . $savedFilesDataPath);
    }
});

test('the reaper keeps a file that still has a row', function (): void {
    $name = 'aaaaaaaa-0000-4000-8000-000000000001.png';
    $path = reapWriteAttachment($this->convId, $name);

    $this->pdo->prepare(
        "insert into global.conversation_images
         (id, conversation_id, attachment_index, filename, media_type, filesize, checksum, object_key)
         values (:id, :cid, 1, :fn, 'image/png', 10, 'abc', :key)"
    )->execute([
        ':id' => 'cccccccc-dddd-4eee-8fff-000000000001',
        ':cid' => $this->convId,
        ':fn' => $name,
        ':key' => reapObjectKey($this->convId, $name),
    ]);

    Runner::runCleanupOnce($this->pdo);

    expect(file_exists($path))->toBeTrue('a live attachment must never be reaped');
});

test('the reaper deletes a file whose row was never written', function (): void {
    $name = 'aaaaaaaa-0000-4000-8000-000000000002.png';
    $path = reapWriteAttachment($this->convId, $name);

    Runner::runCleanupOnce($this->pdo);

    expect(file_exists($path))->toBeFalse('an orphaned file must be collected');
    expect(is_dir(REAP_ROOT . '/chat/' . $this->convId . '/images'))->toBeFalse('empty dirs are pruned');
});

test('the reaper deletes a file whose conversation was deleted', function (): void {
    $name = 'aaaaaaaa-0000-4000-8000-000000000003.png';
    $path = reapWriteAttachment($this->convId, $name);

    // Conversation gone (its attachment rows cascaded away) while the bytes
    // survived — the process died before the explicit sweep could run.
    $this->pdo->prepare('delete from global.conversations where id = :id')
        ->execute([':id' => $this->convId]);

    Runner::runCleanupOnce($this->pdo);

    expect(file_exists($path))->toBeFalse();
});

test('the reaper leaves a fresh file alone (a request may be mid-write)', function (): void {
    $name = 'aaaaaaaa-0000-4000-8000-000000000004.png';
    $path = reapWriteAttachment($this->convId, $name, false);

    Runner::runCleanupOnce($this->pdo);

    expect(file_exists($path))->toBeTrue(
        'bytes written seconds ago are assumed to belong to a request whose insert has not landed yet'
    );
});

test('the reaper never touches note files or anything outside chat/', function (): void {
    $dir = REAP_ROOT . '/notes/some-nook';
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    $noteFile = $dir . '/v1';
    file_put_contents($noteFile, 'note-bytes');
    touch($noteFile, time() - 7200);

    Runner::runCleanupOnce($this->pdo);

    expect(file_exists($noteFile))->toBeTrue('note files have a different lifetime — out of scope here');
});
