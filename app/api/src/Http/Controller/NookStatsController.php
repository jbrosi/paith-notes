<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;

final class NookStatsController
{
    public function stats(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $stats = [];

        // Total counts
        $stmt = $pdo->prepare('SELECT count(*) FROM global.notes WHERE nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_notes'] = (int) $stmt->fetchColumn();

        $stmt = $pdo->prepare('SELECT count(*) FROM global.note_types WHERE nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_types'] = (int) $stmt->fetchColumn();

        $stmt = $pdo->prepare('SELECT count(*) FROM global.note_links WHERE nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_links'] = (int) $stmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT count(*) FROM global.note_mentions m
             JOIN global.notes n ON m.source_note_id = n.id
             WHERE n.nook_id = :nook_id'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_mentions'] = (int) $stmt->fetchColumn();

        $stmt = $pdo->prepare('SELECT count(*) FROM global.conversations WHERE nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_conversations'] = (int) $stmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT COALESCE(SUM(nf.filesize), 0)
             FROM global.note_files nf
             JOIN global.notes n ON n.id = nf.note_id
             WHERE n.nook_id = :nook_id'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['total_file_size'] = (int) $stmt->fetchColumn();

        // Unlinked notes (no links and no mentions, either direction)
        $stmt = $pdo->prepare(
            'SELECT count(*) FROM global.notes n
             WHERE n.nook_id = :nook_id
               AND NOT EXISTS (SELECT 1 FROM global.note_links l WHERE l.source_note_id = n.id OR l.target_note_id = n.id)
               AND NOT EXISTS (SELECT 1 FROM global.note_mentions m WHERE m.source_note_id = n.id OR m.target_note_id = n.id)'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['unlinked_notes'] = (int) $stmt->fetchColumn();

        // Notes per type
        $stmt = $pdo->prepare(
            "SELECT COALESCE(t.label, '(untyped)') AS label, count(n.id) AS count
             FROM global.notes n
             LEFT JOIN global.note_types t ON n.type_id = t.id
             WHERE n.nook_id = :nook_id
             GROUP BY t.label
             ORDER BY count DESC
             LIMIT 20"
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['notes_per_type'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Recently edited notes
        $stmt = $pdo->prepare(
            'SELECT id, title, updated_at
             FROM global.notes
             WHERE nook_id = :nook_id
             ORDER BY updated_at DESC
             LIMIT 8'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['recently_edited'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Most linked notes (by incoming links)
        $stmt = $pdo->prepare(
            'SELECT n.id, n.title, count(l.id) AS link_count
             FROM global.notes n
             JOIN global.note_links l ON l.target_note_id = n.id
             WHERE n.nook_id = :nook_id
             GROUP BY n.id, n.title
             ORDER BY link_count DESC
             LIMIT 8'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['most_linked'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Most mentioned notes (by incoming mentions)
        $stmt = $pdo->prepare(
            'SELECT n.id, n.title, count(m.id) AS mention_count
             FROM global.notes n
             JOIN global.note_mentions m ON m.target_note_id = n.id
             WHERE n.nook_id = :nook_id
             GROUP BY n.id, n.title
             ORDER BY mention_count DESC
             LIMIT 8'
        );
        $stmt->execute([':nook_id' => $nookId]);
        $stats['most_mentioned'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Most viewed by this user (personal frequency)
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        $stmt = $pdo->prepare(
            'SELECT n.id, n.title, SUM(nv.count) AS view_count
             FROM global.note_views nv
             JOIN global.notes n ON n.id = nv.note_id
             WHERE nv.nook_id = :nook_id AND nv.user_id = :user_id
             GROUP BY n.id, n.title
             ORDER BY view_count DESC
             LIMIT 8'
        );
        $stmt->execute([':nook_id' => $nookId, ':user_id' => $userId]);
        $stats['most_viewed'] = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return JsonResponse::ok(['stats' => $stats]);
    }

    public function recentlyViewed(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';

        $stmt = $pdo->prepare(
            'SELECT n.id, n.title, nv.last_seen_at
             FROM global.note_viewers nv
             JOIN global.notes n ON n.id = nv.note_id
             WHERE nv.user_id = :user_id AND nv.nook_id = :nook_id
             ORDER BY nv.last_seen_at DESC
             LIMIT 10'
        );
        $stmt->execute([':user_id' => $userId, ':nook_id' => $nookId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $notes[] = [
                'id' => (string)$r['id'],
                'title' => (string)$r['title'],
                'last_seen_at' => (string)$r['last_seen_at'],
            ];
        }

        return JsonResponse::ok(['notes' => $notes]);
    }

    public function unlinkedNotes(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->routeParam('nookId'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nookId must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $limitRaw = $request->queryParam('limit');
        $limit = min(50, max(1, $limitRaw !== '' ? (int)$limitRaw : 30));
        $offsetRaw = $request->queryParam('offset');
        $offset = $offsetRaw !== '' ? max(0, (int)$offsetRaw) : 0;

        $stmt = $pdo->prepare(
            'SELECT n.id, n.title, n.type, n.type_id, n.created_at, n.updated_at
             FROM global.notes n
             WHERE n.nook_id = :nook_id
               AND NOT EXISTS (SELECT 1 FROM global.note_links l WHERE l.source_note_id = n.id OR l.target_note_id = n.id)
               AND NOT EXISTS (SELECT 1 FROM global.note_mentions m WHERE m.source_note_id = n.id OR m.target_note_id = n.id)
             ORDER BY n.updated_at DESC
             LIMIT :limit OFFSET :offset'
        );
        $stmt->bindValue(':nook_id', $nookId);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $notes = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $notes[] = [
                'id' => (string)$r['id'],
                'title' => (string)$r['title'],
                'type' => (string)($r['type'] ?? 'anything'),
                'type_id' => (string)($r['type_id'] ?? ''),
                'created_at' => (string)$r['created_at'],
                'updated_at' => (string)$r['updated_at'],
            ];
        }

        return JsonResponse::ok(['notes' => $notes]);
    }

    private static function isUuid(string $value): bool
    {
        return (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value);
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): void
    {
        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';
        if ($userId === '') {
            throw new HttpError('invalid user', 500);
        }
        $stmt = $pdo->prepare('SELECT role FROM global.nook_members WHERE nook_id = :nook_id AND user_id = :user_id');
        $stmt->execute([':nook_id' => $nookId, ':user_id' => $userId]);
        $role = $stmt->fetchColumn();
        if (!is_string($role) || $role === '') {
            throw new HttpError('forbidden', 403);
        }
    }
}
