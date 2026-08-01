<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

use PDO;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Shared\Uuid;

final class MentionsService
{
    /**
     * @param string $userId The user creating the mention — needed for cross-nook access checks
     */
    public function syncMentions(PDO $pdo, string $nookId, string $sourceNoteId, string $markdown, string $userId = ''): void
    {
        // Diff-based sync. The old approach was DELETE-all-then-reinsert,
        // which fired the note_stats_mentions_fn trigger per row for every
        // mention on every save — 100 mentions × (1 delete + 1 insert) = 200
        // trigger fires, even for a one-word edit. Now we compute the set
        // difference in PHP and only touch what actually changed:
        //
        //   toDelete  targets in old set, not in new  → DELETE (fires trigger)
        //   toInsert  targets in new set, not in old  → INSERT (fires trigger)
        //   toUpdate  same target, changed position/title → UPDATE (no trigger)
        //
        // Combined with the narrowed trigger (INSERT/DELETE only, see
        // GlobalSchema.php), a no-op or position-only edit fires zero stats
        // updates.
        //
        // Deadlock prevention: even the reduced INSERT/DELETE set can cycle
        // on stats rows shared with other parallel edits. Before touching
        // anything we take row locks on stats rows for {source} + toDelete
        // targets + toInsert targets, in ascending note_id order. Any
        // parallel writer acquires the same locks in the same sequence, so
        // no cycle is possible. Skip the lock loop entirely when nothing
        // changes (toDelete + toInsert both empty) — saves round-trips.
        // Load-bearing for concurrency — do not remove the sort.
        $parsed = self::parseMentionsFromMarkdown($markdown);

        $newByTarget = [];
        foreach ($parsed as $m) {
            if (!Uuid::isValid($m['target_note_id'])) {
                continue;
            }
            // parseMentionsFromMarkdown already dedupes; keep the first entry.
            $newByTarget[$m['target_note_id']] = $m;
        }

        $existingStmt = $pdo->prepare(
            'select target_note_id, position, link_title from global.note_mentions where source_note_id = :src'
        );
        $existingStmt->execute([':src' => $sourceNoteId]);
        $existingByTarget = [];
        foreach ($existingStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $tid = Row::str($row, 'target_note_id');
            if ($tid === '') {
                continue;
            }
            $existingByTarget[$tid] = [
                'position' => Row::int($row, 'position'),
                'link_title' => Row::str($row, 'link_title'),
            ];
        }

        $toDelete = [];
        foreach ($existingByTarget as $tid => $_) {
            if (!isset($newByTarget[$tid])) {
                $toDelete[$tid] = true;
            }
        }

        $toInsert = [];
        $toUpdate = [];
        foreach ($newByTarget as $tid => $m) {
            if (!isset($existingByTarget[$tid])) {
                $toInsert[$tid] = $m;
                continue;
            }
            if (
                (int)$existingByTarget[$tid]['position'] !== (int)$m['offset']
                || $existingByTarget[$tid]['link_title'] !== $m['link_title']
            ) {
                $toUpdate[$tid] = $m;
            }
        }

        // Canonical stats lock — only over rows the trigger will actually
        // touch. UPDATEs skip the trigger entirely, so toUpdate is excluded.
        if ($toDelete !== [] || $toInsert !== []) {
            $touchedIds = [$sourceNoteId];
            foreach (array_keys($toDelete) as $tid) {
                $touchedIds[] = $tid;
            }
            foreach (array_keys($toInsert) as $tid) {
                $touchedIds[] = $tid;
            }
            $sortedIds = array_values(array_unique(array_filter(
                $touchedIds,
                static fn (string $id): bool => Uuid::isValid($id),
            )));
            sort($sortedIds);

            $ensureStats = $pdo->prepare(
                'insert into global.note_stats (note_id, nook_id) '
                . 'select id, nook_id from global.notes where id = :id '
                . 'on conflict (note_id) do nothing'
            );
            $lockStats = $pdo->prepare(
                'select 1 from global.note_stats where note_id = :id for no key update'
            );
            foreach ($sortedIds as $id) {
                $ensureStats->execute([':id' => $id]);
                $lockStats->execute([':id' => $id]);
                $lockStats->fetchAll();
            }
        }

        // Bulk delete removed targets.
        if ($toDelete !== []) {
            $tids = array_keys($toDelete);
            $placeholders = [];
            $params = [':src' => $sourceNoteId];
            foreach ($tids as $i => $tid) {
                $key = ':t' . $i;
                $placeholders[] = $key;
                $params[$key] = $tid;
            }
            $del = $pdo->prepare(
                'delete from global.note_mentions where source_note_id = :src '
                . 'and target_note_id in (' . implode(', ', $placeholders) . ')'
            );
            $del->execute($params);
        }

        // Update kept mentions where position or link_title drifted (no
        // trigger fires — the (source, target) tuple is unchanged).
        if ($toUpdate !== []) {
            $upd = $pdo->prepare(
                'update global.note_mentions set position = :position, link_title = :link_title '
                . 'where source_note_id = :src and target_note_id = :tid'
            );
            foreach ($toUpdate as $tid => $m) {
                $upd->execute([
                    ':src' => $sourceNoteId,
                    ':tid' => $tid,
                    ':position' => (int)$m['offset'],
                    ':link_title' => (string)$m['link_title'],
                ]);
            }
        }

        // Insert new mentions. Sort by target_note_id for defence-in-depth
        // trigger determinism — redundant given the pre-lock, but cheap.
        if ($toInsert === []) {
            return;
        }

        $insertList = array_values($toInsert);
        usort(
            $insertList,
            static fn (array $a, array $b): int => strcmp($a['target_note_id'], $b['target_note_id']),
        );

        // Same-nook check: note must exist in the source nook
        $existsSameNook = $pdo->prepare('select 1 from global.notes where id = :id and nook_id = :nook_id');

        // Cross-nook check: note must exist AND user must be a member of the target nook
        $existsCrossNook = $pdo->prepare(
            'select 1 from global.notes n '
            . 'join global.nook_members nm on nm.nook_id = n.nook_id and nm.user_id = :user_id '
            . 'where n.id = :id and n.nook_id = :nook_id'
        );

        $insert = $pdo->prepare(
            'insert into global.note_mentions (source_note_id, target_note_id, position, link_title) values (:source_note_id, :target_note_id, :position, :link_title)'
        );

        foreach ($insertList as $m) {
            $target = $m['target_note_id'];
            $targetNookId = $m['target_nook_id'];
            $title = $m['link_title'];
            $offset = $m['offset'];

            if ($targetNookId !== '' && $targetNookId !== $nookId) {
                // Cross-nook mention: verify note exists in that nook AND user has access
                if ($userId === '' || !Uuid::isValid($targetNookId)) {
                    continue;
                }
                $existsCrossNook->execute([':id' => $target, ':nook_id' => $targetNookId, ':user_id' => $userId]);
                if (!$existsCrossNook->fetchColumn()) {
                    continue;
                }
            } else {
                // Same-nook mention: note must exist in the current nook
                $existsSameNook->execute([':id' => $target, ':nook_id' => $nookId]);
                if (!$existsSameNook->fetchColumn()) {
                    continue;
                }
            }

            $insert->execute([
                ':source_note_id' => $sourceNoteId,
                ':target_note_id' => $target,
                ':position' => $offset,
                ':link_title' => $title,
            ]);
        }
    }

    /** @return array<int, array{target_note_id: string, target_nook_id: string, link_title: string, offset: int}> */
    public static function parseMentionsFromMarkdown(string $markdown): array
    {
        // Matches [[note:uuid]] and [[note:nookId/noteId]] wiki-links
        $wikiPattern = '/\[\[note:(?:(?<nook>[0-9a-f-]+)\/)?(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\]/i';
        // Matches [title](note:uuid) and [title](note:nookId/noteId) markdown links
        $linkPattern = '/!?\[(?<title>[^\]]*)\]\(note(?:-ref)?:(?:(?<nook>[0-9a-f-]+)\/)?(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\s+"(?<caption>[^"]*)")?\)/i';

        $out = [];

        // Parse wiki-links [[note:...]]
        $matches = [];
        $count = preg_match_all($wikiPattern, $markdown, $matches, PREG_OFFSET_CAPTURE);
        if (is_int($count) && $count > 0) {
            $matchCount = count($matches['uuid']);
            for ($i = 0; $i < $matchCount; $i++) {
                $uuid = $matches['uuid'][$i][0] ?? '';
                $nookRef = $matches['nook'][$i][0] ?? '';
                $offset = $matches['uuid'][$i][1] ?? 0;
                $out[] = [
                    'target_note_id' => $uuid,
                    'target_nook_id' => $nookRef,
                    'link_title' => '',
                    'offset' => $offset,
                ];
            }
        }

        // Parse markdown links [title](note:...)
        $matches = [];
        $count = preg_match_all($linkPattern, $markdown, $matches, PREG_OFFSET_CAPTURE);
        if (is_int($count) && $count > 0) {
            $matchCount = count($matches['uuid']);
            for ($i = 0; $i < $matchCount; $i++) {
                $title = $matches['title'][$i][0] ?? '';
                $caption = $matches['caption'][$i][0] ?? '';
                $nookRef = $matches['nook'][$i][0] ?? '';
                $uuid = $matches['uuid'][$i][0] ?? '';
                $offset = $matches['uuid'][$i][1] ?? 0;

                $linkTitle = trim((string)$caption);
                if ($linkTitle === '') {
                    $linkTitle = trim((string)$title);
                }

                $out[] = [
                    'target_note_id' => $uuid,
                    'target_nook_id' => $nookRef,
                    'link_title' => $linkTitle,
                    'offset' => $offset,
                ];
            }
        }

        // Deduplicate by target_note_id (keep first occurrence)
        $seen = [];
        $deduped = [];
        foreach ($out as $m) {
            $tid = $m['target_note_id'];
            if (isset($seen[$tid])) {
                continue;
            }
            $seen[$tid] = true;
            $deduped[] = $m;
        }

        usort($deduped, static fn (array $a, array $b): int => $a['offset'] <=> $b['offset']);
        return $deduped;
    }
}
