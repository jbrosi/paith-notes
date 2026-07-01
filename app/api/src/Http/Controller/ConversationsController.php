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
use Paith\Notes\Shared\Db\Rows\ConversationBlockRow;
use Paith\Notes\Shared\Db\Rows\ConversationRow;
use Paith\Notes\Shared\Uuid;
use PDO;
use ZipArchive;
use Paith\Notes\Api\Http\Auth\User;

final class ConversationsController
{
    private const DEFAULT_MODEL = 'claude-sonnet-5';

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
            $conversations[] = ConversationRow::fromRow($row)->toArray();
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
            $block = ConversationBlockRow::fromRow($row);
            if ($block->turnId === '') {
                continue;
            }
            if (!isset($turns[$block->turnId])) {
                $turns[$block->turnId] = [
                    'id'              => $block->turnId,
                    'conversation_id' => $conversationId,
                    'role'            => $block->role,
                    'model'           => $block->model,
                    'content'         => [],
                    'created_at'      => $block->turnCreatedAt(),
                ];
                $turnOrder[] = $block->turnId;
            }
            // Re-decode without associative flag so empty objects like
            // tool_use input:{} stay as stdClass and re-serialize to {}.
            $blockContent = json_decode(is_string($row['content']) ? $row['content'] : 'null');
            if ($blockContent !== null) {
                $content = is_array($turns[$block->turnId]['content'] ?? null) ? $turns[$block->turnId]['content'] : [];
                $content[] = $blockContent;
                $turns[$block->turnId]['content'] = $content;
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
        $noteNookStmt->execute([':note_id' => $noteId, ':user_id' => $user->id]);
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
            $out[] = ConversationRow::fromRow($row)->toArray();
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
            $out[$convId][] = ConversationBlockRow::fromRow($row)->toBlockArray();
        }
        return $out;
    }

    /**
     * POST /conversations/{conversationId}/save-as-note
     * body: { nook_id: string }
     *
     * Save the text portion of one conversation as a note in a chosen
     * nook. Reuses the export-style markdown but drops non-text blocks
     * (tool_use / tool_result / image outputs) — the point of saving
     * is to capture the human-facing outcome, not the mechanics.
     *
     * Creates the note as `base` type (bootstrapping if the nook
     * doesn't have one yet, same fallback pattern as elsewhere).
     */
    public function saveAsNote(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $convId = trim($request->routeParam('conversationId'));
        if (!Uuid::isValid($convId)) {
            throw new HttpError('conversationId must be a UUID', 400);
        }

        $body = $request->jsonBody();
        $nookId = JsonReader::requireUuid($body, 'nook_id');

        // Ownership (conversation) + write access (target nook). Both
        // checks fire independently — user might own the conversation
        // but not have write access on the target nook.
        $conv = $this->requireConversationOwner($pdo, $user, $convId);
        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        // Load conversation metadata + blocks. exportMine goes through
        // a grouped-by-conv fetch that scans all the user's convs; for
        // one-shot save we query for just this conv, cheaper.
        $convMeta = self::fetchConversationById($pdo, $convId);
        if ($convMeta === null) {
            throw new HttpError('conversation not found', 404);
        }
        $blocks = self::fetchBlocksForConversation($pdo, $convId);

        // Text-only render — see renderConversationMarkdownTextOnly.
        $markdown = self::renderConversationMarkdownTextOnly($convMeta, $blocks);

        // Resolve the base type for the target nook, bootstrapping if
        // needed (same pattern AiImagesController uses for the file type).
        $baseTypeId = self::ensureBaseType($pdo, $nookId);

        // Title: use conversation title if present, else a stub with the
        // conversation's created_at date so the note is still findable.
        $title = $convMeta['title'] !== ''
            ? $convMeta['title']
            : 'Conversation ' . substr($convMeta['created_at'], 0, 10);

        // Insert the note. Attributes empty — a plain base note.
        $stmt = $pdo->prepare(
            'insert into global.notes (nook_id, created_by, title, content, type_id, attributes) '
            . "values (:nook_id, :created_by, :title, :content, :type_id, '{}'::jsonb) "
            . 'returning id, created_at, version'
        );
        $stmt->execute([
            ':nook_id' => $nookId,
            ':created_by' => $user->id,
            ':title' => $title,
            ':content' => $markdown,
            ':type_id' => $baseTypeId !== '' ? $baseTypeId : null,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('failed to create note', 500);
        }

        return JsonResponse::ok([
            'note' => [
                'id' => Row::str($row, 'id'),
                'nook_id' => $nookId,
                'title' => $title,
                'created_at' => Row::str($row, 'created_at'),
                'version' => Row::int($row, 'version'),
            ],
        ]);
    }

    /**
     * @return array{id: string, title: string, model: string, created_at: string, updated_at: string}|null
     */
    private static function fetchConversationById(PDO $pdo, string $convId): ?array
    {
        $stmt = $pdo->prepare(
            'select id, title, model, created_at, updated_at '
            . 'from global.conversations where id = :id limit 1'
        );
        $stmt->execute([':id' => $convId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        return [
            'id' => Row::str($row, 'id'),
            'title' => Row::str($row, 'title'),
            'model' => Row::str($row, 'model'),
            'created_at' => Row::str($row, 'created_at'),
            'updated_at' => Row::str($row, 'updated_at'),
        ];
    }

    /**
     * @return list<array{turn_id: string, role: string, block_type: string, content: mixed, model: ?string, created_at: string}>
     */
    private static function fetchBlocksForConversation(PDO $pdo, string $convId): array
    {
        $stmt = $pdo->prepare('
            select b.id, b.conversation_id, b.turn_id, b.role, b.block_index, b.block_type, b.content, b.model, b.created_at,
                   min(b.created_at) over (partition by b.turn_id) as turn_started_at
            from global.conversation_blocks b
            where b.conversation_id = :conv_id
            order by turn_started_at asc, b.turn_id asc, b.block_index asc
        ');
        $stmt->execute([':conv_id' => $convId]);

        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $out[] = ConversationBlockRow::fromRow($row)->toBlockArray();
        }
        return $out;
    }

    /**
     * Bootstrap the nook's `base` note type if needed. Matches the
     * pattern used elsewhere (AiImagesController) but scoped to just
     * the base type — the caller is creating a plain note.
     */
    private static function ensureBaseType(PDO $pdo, string $nookId): string
    {
        $lookup = $pdo->prepare(
            "select id from global.note_types where nook_id = :nook_id and key = 'base' limit 1"
        );
        $lookup->execute([':nook_id' => $nookId]);
        $id = $lookup->fetchColumn();
        if (is_string($id) && $id !== '') {
            return $id;
        }
        // Nook has never had its type table touched — insert base.
        $insert = $pdo->prepare(
            "insert into global.note_types (nook_id, key, label) "
            . "values (:nook_id, 'base', 'Note') "
            . 'on conflict (nook_id, key) do nothing '
            . 'returning id'
        );
        $insert->execute([':nook_id' => $nookId]);
        $newId = $insert->fetchColumn();
        if (is_string($newId) && $newId !== '') {
            return $newId;
        }
        // Race — someone else inserted it; re-read.
        $lookup->execute([':nook_id' => $nookId]);
        $id = $lookup->fetchColumn();
        return is_string($id) ? $id : '';
    }

    /**
     * Text-only variant of renderConversationMarkdown. Drops blocks
     * whose type isn't 'text' (tool_use, tool_result, images, etc)
     * because save-as-note captures the human-readable outcome, not
     * the mechanics. Turns without any surviving text blocks are
     * suppressed so we don't emit empty "## You (…)" headers.
     *
     * @param array{id: string, title: string, model: string, created_at: string, updated_at: string} $conv
     * @param list<array{turn_id: string, role: string, block_type: string, content: mixed, model: ?string, created_at: string}> $blocks
     */
    private static function renderConversationMarkdownTextOnly(array $conv, array $blocks): string
    {
        $fm = ExportHelpers::renderFrontmatter([
            'id' => $conv['id'],
            'title' => $conv['title'] !== '' ? $conv['title'] : 'Untitled',
            'model' => $conv['model'],
            'created_at' => $conv['created_at'],
            'updated_at' => $conv['updated_at'],
            'kind' => 'saved-conversation',
        ]);

        $md = $fm . '# ' . ($conv['title'] !== '' ? $conv['title'] : 'Untitled') . "\n\n";

        // Group text blocks by turn so the "## You / ## Assistant" header
        // only appears once per turn even if it had multiple text blocks.
        $currentTurn = '';
        $turnHasText = false;
        foreach ($blocks as $block) {
            if ($block['block_type'] !== 'text') {
                continue;
            }
            $text = is_array($block['content']) && is_string($block['content']['text'] ?? null)
                ? (string)$block['content']['text']
                : '';
            if (trim($text) === '') {
                continue;
            }

            if ($block['turn_id'] !== $currentTurn) {
                $currentTurn = $block['turn_id'];
                $turnHasText = true;
                $who = $block['role'] === 'user' ? 'You' : 'Assistant';
                $modelHint = $block['role'] === 'assistant' && $block['model'] !== null && $block['model'] !== ''
                    ? ", {$block['model']}"
                    : '';
                $md .= "\n## {$who} ({$block['created_at']}{$modelHint})\n\n";
            }
            $md .= $text . "\n\n";
        }

        if (!$turnHasText) {
            $md .= "\n_(This conversation had no text content — only tool calls or system messages.)_\n";
        }

        return $md;
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
    private function requireConversationOwner(PDO $pdo, User $user, string $conversationId): array
    {
        $stmt = $pdo->prepare('
            select id, title, model
            from global.conversations
            where id = :id and user_id = :user_id
            limit 1
        ');
        $stmt->execute([':id' => $conversationId, ':user_id' => $user->id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('conversation not found', 404);
        }
        /** @var array<string, mixed> $row */
        return $row;
    }
}
