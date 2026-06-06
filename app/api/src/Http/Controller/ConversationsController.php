<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Controller\Export\ExportHelpers;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\FileResponse;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use Paith\Notes\Shared\Uuid;
use PDO;
use ZipArchive;

final class ConversationsController
{
    private const DEFAULT_MODEL = 'claude-sonnet-4-6';

    public function create(Request $request, Context $context): Response
    {
        $pdo  = $context->pdo();
        $user = $context->user();
        $userId = $context->userId();
        $data = $request->jsonBody();

        $model = JsonReader::optionalTrimmedString($data, 'model', self::DEFAULT_MODEL);
        if ($model === '') {
            $model = self::DEFAULT_MODEL;
        }

        $titleRaw = JsonReader::optionalTrimmedString($data, 'title');
        $title    = mb_substr($titleRaw, 0, 255);

        $stmt = $pdo->prepare('
            insert into global.conversations (user_id, title, model)
            values (:user_id, :title, :model)
            returning id, created_at, updated_at
        ');
        $stmt->execute([
            ':user_id' => $userId,
            ':title'   => $title,
            ':model'   => $model,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('failed to create conversation', 500);
        }

        return JsonResponse::ok([
            'conversation' => [
                'id'         => Row::str($row, 'id'),
                'title'      => $title,
                'model'      => $model,
                'created_at' => Row::str($row, 'created_at'),
                'updated_at' => Row::str($row, 'updated_at'),
            ],
        ]);
    }

    public function list(Request $request, Context $context): Response
    {
        $pdo    = $context->pdo();
        $userId = $context->userId();

        $stmt = $pdo->prepare('
            select id, title, model, created_at, updated_at
            from global.conversations
            where user_id = :user_id
            order by updated_at desc
        ');
        $stmt->execute([':user_id' => $userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $conversations = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $conversations[] = [
                'id'         => Row::str($row, 'id'),
                'title'      => Row::str($row, 'title'),
                'model'      => Row::str($row, 'model'),
                'created_at' => Row::str($row, 'created_at'),
                'updated_at' => Row::str($row, 'updated_at'),
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

        $conversationId = $request->requireUuidRouteParam('conversationId');

        $this->requireConversationOwner($pdo, $user, $conversationId);

        // Decode without associative flag so empty JSON objects (tool_use input:{})
        // are preserved as stdClass and re-encode correctly as {} rather than [].
        $body     = json_decode($request->body());
        $messages = (is_object($body) && is_array($body->messages ?? null)) ? $body->messages : null;
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

            $turnId      = Uuid::v4();
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
                    'id'          => Row::str($row, 'id'),
                    'block_type'  => $blockType,
                    'block_index' => (int)$blockIndex,
                    'created_at'  => Row::str($row, 'created_at'),
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

        $conversationId = $request->requireUuidRouteParam('conversationId');

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
            $turnId = Row::str($row, 'turn_id');
            if ($turnId === '') {
                continue;
            }
            if (!isset($turns[$turnId])) {
                $createdAt = $row['turn_started_at'] ?? $row['created_at'] ?? null;
                $turns[$turnId] = [
                    'id'              => $turnId,
                    'conversation_id' => $conversationId,
                    'role'            => Row::str($row, 'role'),
                    'model'           => isset($row['model']) && is_string($row['model']) ? $row['model'] : null,
                    'content'         => [],
                    'created_at'      => is_scalar($createdAt) ? (string)$createdAt : '',
                ];
                $turnOrder[] = $turnId;
            }
            $blockContent = json_decode(is_string($row['content']) ? $row['content'] : 'null');
            if ($blockContent !== null) {
                $content = is_array($turns[$turnId]['content'] ?? null) ? $turns[$turnId]['content'] : [];
                $content[] = $blockContent;
                $turns[$turnId]['content'] = $content;
            }
        }

        $messages = array_map(static fn(string $id) => $turns[$id], $turnOrder);

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

        $conversationId = $request->requireUuidRouteParam('conversationId');

        $this->requireConversationOwner($pdo, $user, $conversationId);

        $data   = $request->jsonBody();
        $noteId = JsonReader::optionalTrimmedString($data, 'note_id');
        if ($noteId === '' || !Uuid::isValid($noteId)) {
            throw new HttpError('note_id must be a UUID', 400);
        }

        $blockId = JsonReader::optionalTrimmedString($data, 'block_id');
        if ($blockId !== '' && !Uuid::isValid($blockId)) {
            throw new HttpError('block_id must be a UUID if provided', 400);
        }

        // Verify the caller has access to the note's nook — without this,
        // a user could link any random note id to their own conversation.
        $noteNookStmt = $pdo->prepare('
            select n.nook_id from global.notes n
            join global.nook_members nm on nm.nook_id = n.nook_id
            where n.id = :note_id and nm.user_id = :user_id
            limit 1
        ');
        $noteNookStmt->execute([':note_id' => $noteId, ':user_id' => $user['id']]);
        if ($noteNookStmt->fetchColumn() === false) {
            throw new HttpError('note not found', 404);
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

    /**
     * Delete a single conversation owned by the caller.
     * Cascades to conversation_blocks via FK on delete cascade.
     */
    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $userId = $context->userId();

        $conversationId = $request->requireUuidRouteParam('conversationId');

        $stmt = $pdo->prepare('
            delete from global.conversations
            where id = :id and user_id = :user_id
            returning id
        ');
        $stmt->execute([':id' => $conversationId, ':user_id' => $userId]);
        if ($stmt->fetchColumn() === false) {
            throw new HttpError('conversation not found', 404);
        }

        return JsonResponse::ok(['deleted' => true, 'conversation_id' => $conversationId]);
    }

    /**
     * Delete every conversation belonging to the caller. Returns the count
     * deleted. No history retained — the conversation rows are gone.
     */
    public function deleteAll(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $userId = $context->userId();

        $stmt = $pdo->prepare('delete from global.conversations where user_id = :user_id');
        $stmt->execute([':user_id' => $userId]);

        return JsonResponse::ok(['deleted' => true, 'count' => $stmt->rowCount()]);
    }

    /**
     * Export all of the caller's conversations as a zip.
     *
     * Layout mirrors the nook export so the two formats feel consistent:
     *   manifest.json          — schema_version, exported_at, stats
     *   meta/conversations.json — full conversation rows
     *   meta/blocks.json        — every block, ordered, for lossless re-import
     *   conversations/<title>.md — one human-readable markdown per chat
     */
    public function exportMine(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $userId = $context->userId();

        $conversations = $this->fetchConversationsForUser($pdo, $userId);
        $blocksByConv = $this->fetchBlocksGroupedByConversation($pdo, $userId);

        $tmpFile = tempnam(sys_get_temp_dir(), 'conv-export-') . '.zip';
        $zip = new ZipArchive();
        if ($zip->open($tmpFile, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new HttpError('Failed to create export archive', 500);
        }

        $zip->addFromString('meta/conversations.json', ExportHelpers::jsonEncode($conversations));
        $zip->addFromString('meta/blocks.json', ExportHelpers::jsonEncode($blocksByConv));

        $pathCounts = [];
        $blockCount = 0;
        foreach ($conversations as $conv) {
            $blocks = $blocksByConv[$conv['id']] ?? [];
            $blockCount += count($blocks);

            $title = $conv['title'] !== '' ? $conv['title'] : 'Untitled';
            $safe = ExportHelpers::safeFilename($title);
            // Disambiguate when two conversations share a title.
            $pathCounts[$safe] = ($pathCounts[$safe] ?? 0) + 1;
            $filename = $pathCounts[$safe] > 1
                ? "{$safe} ({$pathCounts[$safe]}).md"
                : "{$safe}.md";

            $zip->addFromString("conversations/{$filename}", self::renderConversationMarkdown($conv, $blocks));
        }

        $stats = [
            'conversations' => count($conversations),
            'blocks' => $blockCount,
        ];
        $zip->addFromString('manifest.json', ExportHelpers::jsonEncode([
            'schema_version' => 1,
            'exported_at' => date('c'),
            'kind' => 'paith-conversations',
            'user_id' => $userId,
            'stats' => $stats,
        ]));

        $zip->close();

        $date = date('Y-m-d_His');
        return new FileResponse($tmpFile, 200, [
            'Content-Type' => 'application/zip',
            'Content-Disposition' => "attachment; filename=\"conversations_{$date}.zip\"",
            'Content-Length' => (string) filesize($tmpFile),
        ]);
    }

    /**
     * @return list<array{id: string, title: string, model: string, created_at: string, updated_at: string}>
     */
    private function fetchConversationsForUser(PDO $pdo, string $userId): array
    {
        $stmt = $pdo->prepare('
            select id, title, model, created_at, updated_at
            from global.conversations
            where user_id = :user_id
            order by created_at asc
        ');
        $stmt->execute([':user_id' => $userId]);

        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $out[] = [
                'id' => Row::str($row, 'id'),
                'title' => Row::str($row, 'title'),
                'model' => Row::str($row, 'model'),
                'created_at' => Row::str($row, 'created_at'),
                'updated_at' => Row::str($row, 'updated_at'),
            ];
        }
        return $out;
    }

    /**
     * @return array<string, list<array{id: string, turn_id: string, role: string, block_index: int, block_type: string, content: mixed, model: ?string, created_at: string}>>
     */
    private function fetchBlocksGroupedByConversation(PDO $pdo, string $userId): array
    {
        $stmt = $pdo->prepare('
            select b.id, b.conversation_id, b.turn_id, b.role, b.block_index, b.block_type, b.content, b.model, b.created_at,
                   min(b.created_at) over (partition by b.turn_id) as turn_started_at
            from global.conversation_blocks b
            join global.conversations c on c.id = b.conversation_id
            where c.user_id = :user_id
            order by b.conversation_id, turn_started_at asc, b.turn_id asc, b.block_index asc
        ');
        $stmt->execute([':user_id' => $userId]);

        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $convId = Row::str($row, 'conversation_id');
            if ($convId === '') {
                continue;
            }
            $rawContent = $row['content'] ?? null;
            $content = is_string($rawContent) ? json_decode($rawContent, true) : $rawContent;

            $out[$convId][] = [
                'id' => Row::str($row, 'id'),
                'turn_id' => Row::str($row, 'turn_id'),
                'role' => Row::str($row, 'role'),
                'block_index' => Row::int($row, 'block_index'),
                'block_type' => Row::str($row, 'block_type'),
                'content' => $content,
                'model' => Row::nullStr($row, 'model'),
                'created_at' => Row::str($row, 'created_at'),
            ];
        }
        return $out;
    }

    /**
     * @param array{id: string, title: string, model: string, created_at: string, updated_at: string} $conv
     * @param list<array{turn_id: string, role: string, block_type: string, content: mixed, model: ?string, created_at: string}> $blocks
     */
    private static function renderConversationMarkdown(array $conv, array $blocks): string
    {
        $fm = ExportHelpers::renderFrontmatter([
            'id' => $conv['id'],
            'title' => $conv['title'] !== '' ? $conv['title'] : 'Untitled',
            'model' => $conv['model'],
            'created_at' => $conv['created_at'],
            'updated_at' => $conv['updated_at'],
        ]);

        $md = $fm . '# ' . ($conv['title'] !== '' ? $conv['title'] : 'Untitled') . "\n\n";

        $currentTurn = '';
        foreach ($blocks as $block) {
            if ($block['turn_id'] !== $currentTurn) {
                $currentTurn = $block['turn_id'];
                $who = $block['role'] === 'user' ? 'You' : 'Assistant';
                $modelHint = $block['role'] === 'assistant' && $block['model'] !== null && $block['model'] !== ''
                    ? ", {$block['model']}"
                    : '';
                $md .= "\n## {$who} ({$block['created_at']}{$modelHint})\n\n";
            }
            $md .= self::renderBlock($block['block_type'], $block['content']) . "\n\n";
        }

        return $md;
    }

    private static function renderBlock(string $type, mixed $content): string
    {
        if ($type === 'text' && is_array($content) && is_string($content['text'] ?? null)) {
            return $content['text'];
        }
        // Tool calls, tool results, images, anything structured — render as a JSON fence
        $label = $type !== '' ? $type : 'block';
        $body = is_string($content) ? $content : (string) json_encode($content, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        return "```{$label}\n{$body}\n```";
    }

    /** @return array<string, mixed> */
    private function requireConversationOwner(PDO $pdo, array $user, string $conversationId): array
    {
        $stmt = $pdo->prepare('
            select id, title, model
            from global.conversations
            where id = :id and user_id = :user_id
            limit 1
        ');
        $stmt->execute([':id' => $conversationId, ':user_id' => $user['id']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('conversation not found', 404);
        }
        /** @var array<string, mixed> $row */
        return $row;
    }
}
