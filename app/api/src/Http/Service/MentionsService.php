<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service;

use PDO;

final class MentionsService
{
    public function syncMentions(PDO $pdo, string $nookId, string $sourceNoteId, string $markdown): void
    {
        $pdo->prepare('delete from global.note_mentions where source_note_id = :source_note_id')->execute([
            ':source_note_id' => $sourceNoteId,
        ]);

        $mentions = self::parseMentionsFromMarkdown($markdown);
        if ($mentions === []) {
            return;
        }

        $exists = $pdo->prepare('select 1 from global.notes where id = :id and nook_id = :nook_id');
        $insert = $pdo->prepare(
            'insert into global.note_mentions (source_note_id, target_note_id, position, link_title) values (:source_note_id, :target_note_id, :position, :link_title)'
        );

        foreach ($mentions as $m) {
            $target = $m['target_note_id'];
            $title = $m['link_title'];
            $offset = $m['offset'];
            if (!self::isUuid($target)) {
                continue;
            }

            $exists->execute([':id' => $target, ':nook_id' => $nookId]);
            if (!$exists->fetchColumn()) {
                continue;
            }

            $insert->execute([
                ':source_note_id' => $sourceNoteId,
                ':target_note_id' => $target,
                ':position' => $offset,
                ':link_title' => $title,
            ]);
        }
    }

    /** @return array<int, array{target_note_id: string, link_title: string, offset: int}> */
    public static function parseMentionsFromMarkdown(string $markdown): array
    {
        $pattern = '/!?\[(?<title>[^\]]*)\]\(note:(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\s+"(?<caption>[^"]*)")?\)/i';

        $matches = [];
        $count = preg_match_all($pattern, $markdown, $matches, PREG_OFFSET_CAPTURE);
        if (!is_int($count) || $count <= 0) {
            return [];
        }

        $out = [];
        $matchCount = count($matches['uuid']);
        for ($i = 0; $i < $matchCount; $i++) {
            $title = $matches['title'][$i][0] ?? '';
            $caption = $matches['caption'][$i][0] ?? '';
            $uuid = $matches['uuid'][$i][0] ?? '';
            $offset = $matches['uuid'][$i][1] ?? 0;

            $linkTitle = trim((string)$caption);
            if ($linkTitle === '') {
                $linkTitle = trim((string)$title);
            }

            $out[] = [
                'target_note_id' => $uuid,
                'link_title' => $linkTitle,
                'offset' => $offset,
            ];
        }

        usort($out, static fn (array $a, array $b): int => $a['offset'] <=> $b['offset']);
        return $out;
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
