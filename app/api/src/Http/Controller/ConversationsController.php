<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;

final class ConversationsController
{
    private const DEFAULT_MODEL = 'claude-sonnet-4-6';

    public function create(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();
        $data = $request->jsonBody();

        $nookId = is_string($data['nook_id'] ?? null) ? trim($data['nook_id']) : '';
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nook_id is required and must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $model = is_string($data['model'] ?? null) ? trim($data['model']) : self::DEFAULT_MODEL;
        if ($model === '') {
            $model = self::DEFAULT_MODEL;
        }

        $titleRaw = is_string($data['title'] ?? null) ? trim($data['title']) : '';
        $title    = mb_substr($titleRaw, 0, 255);

        $stmt = $pdo->prepare('
            insert into global.conversations (nook_id, user_id, title, model)
            values (:nook_id, :user_id, :title, :model)
            returning id, created_at, updated_at
        ');
        $stmt->execute([
            ':nook_id' => $nookId,
            ':user_id' => $user['id'],
            ':title'   => $title,
            ':model'   => $model,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('failed to create conversation', 500);
        }

        return JsonResponse::ok([
            'conversation' => [
                'id'         => (string)$row['id'],
                'nook_id'    => $nookId,
                'title'      => $title,
                'model'      => $model,
                'created_at' => (string)$row['created_at'],
                'updated_at' => (string)$row['updated_at'],
            ],
        ]);
    }

    public function list(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();

        $nookId = trim($request->queryParam('nook_id'));
        if ($nookId === '' || !self::isUuid($nookId)) {
            throw new HttpError('nook_id is required and must be a UUID', 400);
        }

        $this->requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare('
            select id, title, model, created_at, updated_at
            from global.conversations
            where nook_id = :nook_id and user_id = :user_id
            order by updated_at desc
        ');
        $stmt->execute([
            ':nook_id' => $nookId,
            ':user_id' => $user['id'],
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $conversations = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $conversations[] = [
                'id'         => (string)$row['id'],
                'nook_id'    => $nookId,
                'title'      => (string)$row['title'],
                'model'      => (string)$row['model'],
                'created_at' => (string)$row['created_at'],
                'updated_at' => (string)$row['updated_at'],
            ];
        }

        return JsonResponse::ok(['conversations' => $conversations]);
    }

    /**
     * Append one or more message turns to a conversation.
     * Each turn's content array is stored as individual block rows sharing a turn_id.
     * Returns the saved block IDs so callers can reference specific blocks (e.g. for note links).
     */
    public function appendMessages(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();

        $conversationId = trim($request->routeParam('conversationId'));
        if ($conversationId === '' || !self::isUuid($conversationId)) {
            throw new HttpError('conversationId must be a UUID', 400);
        }

        $this->requireConversationOwner($pdo, $user, $conversationId);

        // Decode without associative flag so empty JSON objects (tool_use input:{})
        // are preserved as stdClass and re-encode correctly as {} rather than [].
        $body     = json_decode($request->body());
        $messages = is_array($body->messages ?? null) ? $body->messages : null;
        if ($messages === null || $messages === []) {
            throw new HttpError('messages must be a non-empty array', 400);
        }

        $insert = $pdo->prepare('
            insert into global.conversation_blocks
                (conversation_id, turn_id, role, block_index, block_type, content, model)
            values
                (:conversation_id, :turn_id, :role, :block_index, :block_type, :content, :model)
            returning id, created_at
        ');

        $savedTurns = [];

        foreach ($messages as $message) {
            if (!is_object($message)) {
                throw new HttpError('each message must be an object', 400);
            }

            $role = is_string($message->role ?? null) ? trim($message->role) : '';
            if ($role !== 'user' && $role !== 'assistant') {
                throw new HttpError('message role must be "user" or "assistant"', 400);
            }

            $content = $message->content ?? null;
            if (!is_array($content)) {
                throw new HttpError('message content must be an array of content blocks', 400);
            }

            $model = ($role === 'assistant' && is_string($message->model ?? null))
                ? trim($message->model)
                : null;

            $turnId      = self::generateUuid();
            $savedBlocks = [];

            foreach ($content as $blockIndex => $block) {
                if (!is_object($block)) {
                    continue;
                }

                $blockType = is_string($block->type ?? null) ? trim($block->type) : 'unknown';
                $blockJson = json_encode($block);

                $insert->execute([
                    ':conversation_id' => $conversationId,
                    ':turn_id'         => $turnId,
                    ':role'            => $role,
                    ':block_index'     => (int)$blockIndex,
                    ':block_type'      => $blockType,
                    ':content'         => $blockJson,
                    ':model'           => $model,
                ]);

                $row = $insert->fetch(PDO::FETCH_ASSOC);
                if (!is_array($row)) {
                    throw new HttpError('failed to insert block', 500);
                }

                $blockData = [
                    'id'          => (string)$row['id'],
                    'block_type'  => $blockType,
                    'block_index' => (int)$blockIndex,
                    'created_at'  => (string)$row['created_at'],
                ];

                // Expose tool_use_id so callers can match saved blocks to pending tool uses
                if ($blockType === 'tool_use' && is_string($block->id ?? null)) {
                    $blockData['tool_use_id'] = (string)$block->id;
                }

                $savedBlocks[] = $blockData;
            }

            $savedTurns[] = [
                'turn_id' => $turnId,
                'role'    => $role,
                'model'   => $model,
                'blocks'  => $savedBlocks,
            ];
        }

        // bump conversation updated_at
        $pdo->prepare('update global.conversations set updated_at = now() where id = :id')
            ->execute([':id' => $conversationId]);

        return JsonResponse::ok(['turns' => $savedTurns]);
    }

    public function listMessages(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();

        $conversationId = trim($request->routeParam('conversationId'));
        if ($conversationId === '' || !self::isUuid($conversationId)) {
            throw new HttpError('conversationId must be a UUID', 400);
        }

        $this->requireConversationOwner($pdo, $user, $conversationId);

        $stmt = $pdo->prepare('
            select b.id, b.turn_id, b.role, b.block_index, b.block_type, b.content, b.model, b.created_at,
                   min(b.created_at) over (partition by b.turn_id) as turn_started_at
            from global.conversation_blocks b
            where b.conversation_id = :conversation_id
            order by turn_started_at asc, b.turn_id asc, b.block_index asc
        ');
        $stmt->execute([':conversation_id' => $conversationId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Reconstruct message turns from individual blocks
        /** @var array<string, array<string, mixed>> $turns */
        $turns     = [];
        $turnOrder = [];

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $turnId = (string)$row['turn_id'];
            if (!isset($turns[$turnId])) {
                $turns[$turnId] = [
                    'id'              => $turnId,
                    'conversation_id' => $conversationId,
                    'role'            => (string)$row['role'],
                    'model'           => isset($row['model']) && is_string($row['model']) ? $row['model'] : null,
                    'content'         => [],
                    'created_at'      => (string)($row['turn_started_at'] ?? $row['created_at']),
                ];
                $turnOrder[] = $turnId;
            }
            $blockContent = json_decode(is_string($row['content']) ? $row['content'] : 'null');
            if ($blockContent !== null) {
                $turns[$turnId]['content'][] = $blockContent;
            }
        }

        $messages = array_values(array_map(static fn(string $id) => $turns[$id], $turnOrder));

        return JsonResponse::ok(['messages' => $messages]);
    }

    /**
     * Record a link between a note and this conversation (e.g. AI memory written during this chat).
     * Upserts: if the note was already linked, updates the block reference to the latest write.
     */
    public function createNoteLink(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();

        $conversationId = trim($request->routeParam('conversationId'));
        if ($conversationId === '' || !self::isUuid($conversationId)) {
            throw new HttpError('conversationId must be a UUID', 400);
        }

        $this->requireConversationOwner($pdo, $user, $conversationId);

        $data   = $request->jsonBody();
        $noteId = is_string($data['note_id'] ?? null) ? trim($data['note_id']) : '';
        if ($noteId === '' || !self::isUuid($noteId)) {
            throw new HttpError('note_id must be a UUID', 400);
        }

        $blockId = is_string($data['block_id'] ?? null) ? trim($data['block_id']) : '';
        if ($blockId !== '' && !self::isUuid($blockId)) {
            throw new HttpError('block_id must be a UUID if provided', 400);
        }

        $pdo->prepare('
            insert into global.note_conversation_links (note_id, conversation_id, block_id)
            values (:note_id, :conversation_id, :block_id)
            on conflict (note_id, conversation_id) do update
                set block_id = excluded.block_id
        ')->execute([
            ':note_id'         => $noteId,
            ':conversation_id' => $conversationId,
            ':block_id'        => $blockId !== '' ? $blockId : null,
        ]);

        return JsonResponse::ok(['ok' => true]);
    }

    private function requireMember(PDO $pdo, array $user, string $nookId): void
    {
        $stmt = $pdo->prepare('
            select 1 from global.nook_members
            where nook_id = :nook_id and user_id = :user_id
            limit 1
        ');
        $stmt->execute([':nook_id' => $nookId, ':user_id' => $user['id']]);
        if (!$stmt->fetch()) {
            throw new HttpError('forbidden', 403);
        }
    }

    /** @return array<string, mixed> */
    private function requireConversationOwner(PDO $pdo, array $user, string $conversationId): array
    {
        $stmt = $pdo->prepare('
            select id, nook_id, title, model
            from global.conversations
            where id = :id and user_id = :user_id
            limit 1
        ');
        $stmt->execute([':id' => $conversationId, ':user_id' => $user['id']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('conversation not found', 404);
        }
        return $row;
    }

    private static function generateUuid(): string
    {
        $data    = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    private static function isUuid(string $value): bool
    {
        return (bool) preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }
}
