<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

use PDO;

final class MentionsService
{
    /**
     * @param string $userId The user creating the mention — needed for cross-nook access checks
     */
    public function syncMentions(PDO $pdo, string $nookId, string $sourceNoteId, string $markdown, string $userId = ''): void
    {
        $pdo->prepare('delete from global.note_mentions where source_note_id = :source_note_id')->execute([
            ':source_note_id' => $sourceNoteId,
        ]);

        $mentions = self::parseMentionsFromMarkdown($markdown);
        if ($mentions === []) {
            return;
        }

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

        foreach ($mentions as $m) {
            $target = $m['target_note_id'];
            $targetNookId = $m['target_nook_id'];
            $title = $m['link_title'];
            $offset = $m['offset'];
            if (!self::isUuid($target)) {
                continue;
            }

            if ($targetNookId !== '' && $targetNookId !== $nookId) {
                // Cross-nook mention: verify note exists in that nook AND user has access
                if ($userId === '' || !self::isUuid($targetNookId)) {
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

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
