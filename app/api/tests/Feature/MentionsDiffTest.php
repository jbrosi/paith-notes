<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Service\MentionsService;

/*
 * Correctness tests for the diff-based syncMentions rewrite.
 *
 * syncMentions computes toDelete/toInsert/toUpdate against the current row
 * set and only touches what actually changed — instead of the older
 * delete-all-then-reinsert approach. This exercises each branch and
 * verifies note_stats stays consistent.
 */

beforeEach(function (): void {
    $pdo = test_pdo();
    ensure_global_schema($pdo);
    test_reset_state($pdo);
});

/**
 * @return array{0: string, 1: string, 2: string, 3: string, 4: string}
 *         [nookId, sourceId, targetA, targetB, targetC]
 */
function seedMentionsDiffScenario(\PDO $pdo): array
{
    $userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('$userId', 'Test', 'User') on conflict (id) do nothing");
    $nookId = '33333333-3333-4333-8333-333333333333';
    $pdo->exec("insert into global.nooks (id, name, created_by, owner_id) values ('$nookId', 'Diff', '$userId', '$userId') on conflict (id) do nothing");

    $S = '44444444-0000-4000-8000-000000000000';
    $A = '44444444-1111-4000-8000-000000000000';
    $B = '44444444-2222-4000-8000-000000000000';
    $C = '44444444-3333-4000-8000-000000000000';

    $insert = $pdo->prepare("insert into global.notes (id, nook_id, created_by, title, content) values (:id, '$nookId', '$userId', :title, '')");
    foreach ([[$S, 'S'], [$A, 'A'], [$B, 'B'], [$C, 'C']] as [$id, $title]) {
        $insert->execute([':id' => $id, ':title' => $title]);
    }

    return [$nookId, $S, $A, $B, $C];
}

function currentMentions(\PDO $pdo, string $sourceId): array
{
    $stmt = $pdo->prepare('select target_note_id, position, link_title from global.note_mentions where source_note_id = :src order by target_note_id');
    $stmt->execute([':src' => $sourceId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function statsFor(\PDO $pdo, string $noteId): array
{
    $stmt = $pdo->prepare('select outgoing_mentions, incoming_mentions from global.note_stats where note_id = :id');
    $stmt->execute([':id' => $noteId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? ['outgoing_mentions' => 0, 'incoming_mentions' => 0] : [
        'outgoing_mentions' => (int)$row['outgoing_mentions'],
        'incoming_mentions' => (int)$row['incoming_mentions'],
    ];
}

it('inserts new mentions on first save (empty → {A, B})', function (): void {
    $pdo = test_pdo();
    [$nookId, $S, $A, $B, $C] = seedMentionsDiffScenario($pdo);

    (new MentionsService())->syncMentions($pdo, $nookId, $S, "See [[note:$A]] and [[note:$B]]");

    $rows = currentMentions($pdo, $S);
    expect($rows)->toHaveCount(2);
    expect(statsFor($pdo, $S)['outgoing_mentions'])->toBe(2);
    expect(statsFor($pdo, $A)['incoming_mentions'])->toBe(1);
    expect(statsFor($pdo, $B)['incoming_mentions'])->toBe(1);
});

it('applies full diff: keeps A with new position, removes B, adds C', function (): void {
    $pdo = test_pdo();
    [$nookId, $S, $A, $B, $C] = seedMentionsDiffScenario($pdo);
    $svc = new MentionsService();

    // Initial: mentions A then B
    $svc->syncMentions($pdo, $nookId, $S, "See [[note:$A]] and [[note:$B]]");
    $before = currentMentions($pdo, $S);
    $posA_before = null;
    foreach ($before as $r) {
        if ($r['target_note_id'] === $A) {
            $posA_before = (int)$r['position'];
        }
    }
    expect($posA_before)->not->toBeNull();

    // Rewrite: prefix shifts A's position, drops B, adds C
    $svc->syncMentions($pdo, $nookId, $S, "New prefix here, see [[note:$A]] and now [[note:$C]]");

    $after = currentMentions($pdo, $S);
    $targets = array_column($after, 'target_note_id');
    sort($targets);
    expect($targets)->toBe([$A, $C]);

    // A's position should have moved (prefix shifted the offset)
    $posA_after = null;
    foreach ($after as $r) {
        if ($r['target_note_id'] === $A) {
            $posA_after = (int)$r['position'];
        }
    }
    expect($posA_after)->toBeGreaterThan($posA_before);

    // Stats reflect the diff
    expect(statsFor($pdo, $S)['outgoing_mentions'])->toBe(2);
    expect(statsFor($pdo, $A)['incoming_mentions'])->toBe(1);
    expect(statsFor($pdo, $B)['incoming_mentions'])->toBe(0);
    expect(statsFor($pdo, $C)['incoming_mentions'])->toBe(1);
});

it('no-op edit (same content) does not change row count or ids', function (): void {
    $pdo = test_pdo();
    [$nookId, $S, $A, $B, $C] = seedMentionsDiffScenario($pdo);
    $svc = new MentionsService();

    $markdown = "See [[note:$A]] and [[note:$B]]";
    $svc->syncMentions($pdo, $nookId, $S, $markdown);
    $before = currentMentions($pdo, $S);

    $svc->syncMentions($pdo, $nookId, $S, $markdown);
    $after = currentMentions($pdo, $S);

    expect($after)->toBe($before);
    expect(statsFor($pdo, $S)['outgoing_mentions'])->toBe(2);
});

it('clears all mentions when markdown loses every reference', function (): void {
    $pdo = test_pdo();
    [$nookId, $S, $A, $B, $C] = seedMentionsDiffScenario($pdo);
    $svc = new MentionsService();

    $svc->syncMentions($pdo, $nookId, $S, "See [[note:$A]] and [[note:$B]]");
    expect(statsFor($pdo, $S)['outgoing_mentions'])->toBe(2);

    $svc->syncMentions($pdo, $nookId, $S, "just plain text now");
    expect(currentMentions($pdo, $S))->toBe([]);
    expect(statsFor($pdo, $S)['outgoing_mentions'])->toBe(0);
    expect(statsFor($pdo, $A)['incoming_mentions'])->toBe(0);
    expect(statsFor($pdo, $B)['incoming_mentions'])->toBe(0);
});
