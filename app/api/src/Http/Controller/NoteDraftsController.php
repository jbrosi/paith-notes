<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\User;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Dto\JsonReader;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Db\Row;
use PDO;

/**
 * Per-user unsaved edit buffer for a note. The frontend upserts every
 * few seconds while the user is editing; on note-open it fetches the
 * draft and — if `draft.updated_at > note.updated_at` — surfaces the
 * "you have a draft" recovery banner. Draft is cleared on save
 * (frontend hits DELETE after a successful PUT /notes/{id}) or on
 * explicit discard.
 *
 * Auth model: PUT/DELETE require write access on the nook; GET only
 * requires membership so a user who lost write access can still view /
 * discard their old draft.
 */
final class NoteDraftsController
{
    /**
     * GET /nooks/{nookId}/notes/{noteId}/draft
     * Returns the current user's draft for this note (or draft=null),
     * plus the note's own updated_at so the frontend can compare and
     * decide whether to surface the recovery banner.
     */
    public function get(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');
        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $noteStmt = $pdo->prepare(
            'select updated_at from global.notes where id = :id and nook_id = :nook_id'
        );
        $noteStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        $noteRow = $noteStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($noteRow)) {
            throw new HttpError('note not found', 404);
        }

        $draftStmt = $pdo->prepare(
            'select title, content, version, updated_at from global.note_drafts
             where user_id = :user_id and note_id = :note_id'
        );
        $draftStmt->execute([':user_id' => $user->id, ':note_id' => $noteId]);
        $draftRow = $draftStmt->fetch(PDO::FETCH_ASSOC);

        $draft = null;
        if (is_array($draftRow)) {
            $draft = [
                'note_id' => $noteId,
                'title' => Row::str($draftRow, 'title'),
                'content' => Row::str($draftRow, 'content'),
                'version' => Row::int($draftRow, 'version'),
                'updated_at' => Row::str($draftRow, 'updated_at'),
            ];
        }

        return JsonResponse::ok([
            'draft' => $draft,
            'note_updated_at' => Row::str($noteRow, 'updated_at'),
        ]);
    }

    /**
     * PUT /nooks/{nookId}/notes/{noteId}/draft
     * Body: {title?: string, content?: string}
     *
     * Upserts the current user's draft. Called on a debounce from the
     * editor. Version increments on every upsert so the frontend and AI
     * tools can detect changes without diffing content. updated_at is
     * refreshed by the trigger `default now()` in the update branch.
     */
    public function put(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');
        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireWriteAccess($pdo, $user, $nookId);

        // Ensure the note exists in this nook — we don't want orphaned
        // drafts pointing at cross-nook notes (RLS through FK would drop
        // them on note-delete but we still want an early 404 for typos).
        $existsStmt = $pdo->prepare(
            'select 1 from global.notes where id = :id and nook_id = :nook_id'
        );
        $existsStmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
        if ($existsStmt->fetchColumn() === false) {
            throw new HttpError('note not found', 404);
        }

        $body = $request->jsonBody();
        $title = JsonReader::optionalString($body, 'title', '');
        $content = JsonReader::optionalString($body, 'content', '');

        $upsert = $pdo->prepare(
            "insert into global.note_drafts (user_id, note_id, title, content, version, updated_at)
             values (:user_id, :note_id, :title, :content, 1, now())
             on conflict (user_id, note_id) do update set
                 title = excluded.title,
                 content = excluded.content,
                 version = global.note_drafts.version + 1,
                 updated_at = now()
             returning version, updated_at"
        );
        $upsert->execute([
            ':user_id' => $user->id,
            ':note_id' => $noteId,
            ':title' => $title,
            ':content' => $content,
        ]);
        $row = $upsert->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new HttpError('failed to save draft', 500);
        }

        return JsonResponse::ok([
            'version' => Row::int($row, 'version'),
            'updated_at' => Row::str($row, 'updated_at'),
        ]);
    }

    /**
     * DELETE /nooks/{nookId}/notes/{noteId}/draft
     * Removes the current user's draft for this note. Silently succeeds
     * if there was no draft — the client shouldn't care.
     */
    public function delete(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();

        $nookId = $request->requireUuidRouteParam('nookId');
        $noteId = $request->requireUuidRouteParam('noteId');

        NookAccess::requireMember($pdo, $user, $nookId);

        $stmt = $pdo->prepare(
            'delete from global.note_drafts where user_id = :user_id and note_id = :note_id'
        );
        $stmt->execute([':user_id' => $user->id, ':note_id' => $noteId]);

        return JsonResponse::ok(['deleted' => true]);
    }
}
