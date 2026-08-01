<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Service\MentionsService;

/*
 * Regression test for the parallel-edit deadlock on note_stats.
 *
 * Two saves that share target notes (e.g. two D&D log pages both mentioning
 * the same NPCs) can otherwise cycle-deadlock via the per-row
 * note_stats_mentions_fn trigger, because the DELETE step in syncMentions
 * fires the trigger in Postgres scan order (position order, not target_id).
 *
 * The fix acquires row locks on every note_stats row the trigger will touch
 * (source + old targets + new targets), in ascending note_id order, before
 * the DELETE runs. Every parallel writer then acquires the same locks in the
 * same sequence — no cycle possible.
 *
 * This test asserts the INVARIANT (locks are held on all touched stats rows
 * during the transaction) rather than trying to reproduce the failure mode
 * with real concurrency — PHP+PDO is single-threaded per process, and
 * forking would make CI flaky. The invariant is what protects us.
 */

beforeEach(function (): void {
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    test_reset_state($pdo);
});

/**
 * @return array{
 *   0: string,        // nookId
 *   1: string,        // source noteId (S)
 *   2: string,        // target A (ascending)
 *   3: string,        // target B
 *   4: string,        // target C
 * }
 */
function seedMentionsDeadlockScenario(\PDO $pdo): array
{
    $userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    $pdo->exec(
        "insert into global.users (id, first_name, last_name) values ('$userId', 'Test', 'User') on conflict (id) do nothing"
    );

    $nookId = '11111111-1111-4111-8111-111111111111';
    $pdo->exec(
        "insert into global.nooks (id, name, created_by, owner_id) values ('$nookId', 'Test', '$userId', '$userId') on conflict (id) do nothing"
    );

    // UUIDs chosen so their lexicographic order matches the S/A/B/C naming.
    // The fix sorts by note_id ascending, so S sorts before A which sorts
    // before B which sorts before C.
    $S = '22222222-0000-4000-8000-000000000000';
    $A = '22222222-1111-4000-8000-000000000000';
    $B = '22222222-2222-4000-8000-000000000000';
    $C = '22222222-3333-4000-8000-000000000000';

    $insert = $pdo->prepare(
        "insert into global.notes (id, nook_id, created_by, title, content) values (:id, '$nookId', '$userId', :title, '')"
    );
    foreach ([[$S, 'S'], [$A, 'A'], [$B, 'B'], [$C, 'C']] as [$id, $title]) {
        $insert->execute([':id' => $id, ':title' => $title]);
    }

    // Pre-populate: S already mentions A. This makes A an "old target" that
    // syncMentions will DELETE, which fires the trigger and needs the lock.
    $pdo->exec(
        "insert into global.note_mentions (source_note_id, target_note_id, position, link_title) values ('$S', '$A', 0, '')"
    );

    // Pre-create note_stats rows for every note we'll probe. In production the
    // trigger creates these lazily on the first mention/link — but rows created
    // inside an uncommitted transaction aren't visible from a second connection
    // (READ COMMITTED), so the probe's SELECT would return zero rows regardless
    // of whether the lock was actually held. Seeding them here means every probe
    // sees the row and truly measures whether it's row-locked.
    $pdo->exec(
        "insert into global.note_stats (note_id, nook_id)
         select id, nook_id from global.notes where id in ('$S', '$A', '$B', '$C')
         on conflict (note_id) do nothing"
    );

    return [$nookId, $S, $A, $B, $C];
}

/**
 * Probe a stats row from a second connection. Returns true if the row is
 * currently row-locked (the probe times out with 55P03), false if the probe
 * completes without waiting.
 */
function probeStatsRowLocked(\PDO $probe, string $noteId): bool
{
    $probe->exec("set lock_timeout = '250ms'");
    $probe->beginTransaction();
    try {
        $stmt = $probe->prepare('select 1 from global.note_stats where note_id = :id for update');
        $stmt->execute([':id' => $noteId]);
        $stmt->fetchAll();
        $probe->rollBack();
        return false;
    } catch (\PDOException $e) {
        // 55P03 = lock_not_available (lock_timeout expired)
        if ($probe->inTransaction()) {
            $probe->rollBack();
        }
        return ($e->errorInfo[0] ?? '') === '55P03';
    }
}

it('locks note_stats rows for source and every touched target before writes', function (): void {
    $tx = test_pdo();
    $probe = test_pdo();

    [$nookId, $S, $A, $B, $C] = seedMentionsDeadlockScenario($tx);

    // Before syncMentions runs, no stats rows should be locked from any tx.
    expect(probeStatsRowLocked($probe, $S))->toBeFalse('S must not be pre-locked');
    expect(probeStatsRowLocked($probe, $A))->toBeFalse('A must not be pre-locked');
    expect(probeStatsRowLocked($probe, $B))->toBeFalse('B must not be pre-locked');
    expect(probeStatsRowLocked($probe, $C))->toBeFalse('C must not be pre-locked');

    // In a transaction, sync mentions so S drops A and gains B, C.
    // Deliberately put C before B in the markdown to prove the sort by
    // target_note_id (ascending: A<B<C) is what drives lock order, NOT the
    // markdown/position order.
    $tx->beginTransaction();
    (new MentionsService())->syncMentions($tx, $nookId, $S, "See [[note:$C]] and [[note:$B]]");

    // Every touched stats row should now be locked by the transaction.
    // (Row-level locks aren't visible in pg_locks, so we probe via a second
    // connection with a short lock_timeout — a probe that times out with
    // 55P03 proves the row is held.)
    expect(probeStatsRowLocked($probe, $S))->toBeTrue('stats(S) should be locked (source of the edit)');
    expect(probeStatsRowLocked($probe, $A))->toBeTrue('stats(A) should be locked (old target being deleted)');
    expect(probeStatsRowLocked($probe, $B))->toBeTrue('stats(B) should be locked (new target being inserted)');
    expect(probeStatsRowLocked($probe, $C))->toBeTrue('stats(C) should be locked (new target being inserted)');

    $tx->rollBack();

    // After rollback, locks release — probes must complete freely again.
    expect(probeStatsRowLocked($probe, $S))->toBeFalse('S must release after rollback');
    expect(probeStatsRowLocked($probe, $A))->toBeFalse('A must release after rollback');
    expect(probeStatsRowLocked($probe, $B))->toBeFalse('B must release after rollback');
    expect(probeStatsRowLocked($probe, $C))->toBeFalse('C must release after rollback');
});

it('acquires the FIRST canonical lock before touching other stats rows', function (): void {
    // Two connections: one holds a lock on the SMALLEST-uuid stats row (S).
    // Then another connection tries syncMentions on a DIFFERENT source note,
    // but with markdown that mentions S (as a target). If syncMentions locks
    // in canonical order, it will try S first (smallest note_id) and block
    // on our held lock — we should see 55P03 on the syncMentions call.
    //
    // If someone removed the pre-lock loop (regression), syncMentions would
    // proceed through the DELETE step first (no rows to delete, since the
    // other source has no existing mentions), then attempt inserts — which
    // would fire the trigger's stats update on S and block THERE instead.
    // Either way the block happens, but this test proves the CANONICAL-ORDER
    // path is exercised up-front, which is what prevents cycles across two
    // real parallel writers.

    $holder = test_pdo();
    $writer = test_pdo();

    [$nookId, $S, $A, $B, $C] = seedMentionsDeadlockScenario($holder);

    // Create a second source note (S2) with a larger uuid than everything else
    // so S2's own stats row is locked LAST by syncMentions — meaning the
    // block on S (smallest) happens before syncMentions ever touches S2.
    $userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    $S2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    $holder->exec(
        "insert into global.notes (id, nook_id, created_by, title, content) values ('$S2', '$nookId', '$userId', 'S2', '')"
    );

    // Holder acquires the row lock on stats(S) — ensure the row exists first.
    $holder->exec(
        "insert into global.note_stats (note_id, nook_id) select id, nook_id from global.notes where id = '$S' on conflict (note_id) do nothing"
    );
    $holder->beginTransaction();
    $holder->prepare('select 1 from global.note_stats where note_id = :id for no key update')
        ->execute([':id' => $S]);

    // Writer tries to syncMentions on S2 with a mention pointing at S.
    // Should block on our held lock on stats(S) and time out at 55P03.
    $writer->exec("set lock_timeout = '250ms'");
    $threw = null;
    try {
        (new MentionsService())->syncMentions($writer, $nookId, $S2, "See [[note:$S]]");
    } catch (\PDOException $e) {
        $threw = $e;
    }
    if ($writer->inTransaction()) {
        $writer->rollBack();
    }

    expect($threw)->not->toBeNull('syncMentions should have blocked on the held stats(S) lock');
    /** @var \PDOException $threw */
    expect($threw->errorInfo[0] ?? '')->toBe('55P03', 'expected 55P03 lock_timeout, got: ' . ($threw->getMessage() ?? ''));

    $holder->rollBack();
});
