<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Routes;

use Paith\Notes\Api\Http\Controller\AuthController;
use Paith\Notes\Api\Http\Controller\ChatController;
use Paith\Notes\Api\Http\Controller\ConversationsController;
use Paith\Notes\Api\Http\Controller\FileNotesController;
use Paith\Notes\Api\Http\Controller\FilesController;
use Paith\Notes\Api\Http\Controller\HealthController;
use Paith\Notes\Api\Http\Controller\LinkPredicatesController;
use Paith\Notes\Api\Http\Controller\MeController;
use Paith\Notes\Api\Http\Controller\Module1Controller;
use Paith\Notes\Api\Http\Controller\InvitationsController;
use Paith\Notes\Api\Http\Controller\NookStatsController;
use Paith\Notes\Api\Http\Controller\NoteTypesController;
use Paith\Notes\Api\Http\Controller\NoteLinksController;
use Paith\Notes\Api\Http\Controller\NooksController;
use Paith\Notes\Api\Http\Controller\NotesController;
use Paith\Notes\Api\Http\Middleware\RequireGroup;
use Paith\Notes\Api\Http\Middleware\RequireUser;
use Paith\Notes\Api\Http\RouteScope;

final class ApiRoutes
{
    public static function register(RouteScope $r): void
    {
        $r->get('/auth/check', [AuthController::class, 'check']);
        $r->get('/auth/login', [AuthController::class, 'login']);
        $r->get('/auth/callback', [AuthController::class, 'callback']);
        $r->get('/auth/logout', [AuthController::class, 'logoutRedirect']);
        $r->get('/auth/logout/sso', [AuthController::class, 'logoutSsoRedirect']);
        $r->post('/auth/logout', [AuthController::class, 'logout']);

        // Used by the nginx files sidecar via auth_request
        $r->get('/files/auth', [FilesController::class, 'auth']);

        $r->use('/chat', new RequireUser());
        $r->use('/chat', new RequireGroup('paith/notes/'));

        // Used by the Node.js chat service for forward-auth (browser session cookie → user identity)
        $r->get('/chat/auth', [ChatController::class, 'auth']);

        $r->use('/files', new RequireUser());
        $r->use('/files', new RequireGroup('paith/notes/'));

        $r->use('/me', new RequireUser());
        $r->use('/me', new RequireGroup('paith/notes/'));

        $r->use('/nooks', new RequireUser());
        $r->use('/nooks', new RequireGroup('paith/notes/'));

        $r->use('/module_1', new RequireUser());
        $r->use('/module_1', new RequireGroup('paith/notes/'));

        $r->get('/me', [MeController::class, 'me']);
        $r->get('/nooks', [NooksController::class, 'list']);
        $r->post('/nooks', [NooksController::class, 'create']);
        $r->add('PUT', '/nooks/{nookId}', [NooksController::class, 'update']);

        // Nook sharing: invitations & members
        $r->post('/nooks/{nookId}/invitations', [InvitationsController::class, 'invite']);
        $r->get('/nooks/{nookId}/invitations', [InvitationsController::class, 'listForNook']);
        $r->add('DELETE', '/nooks/{nookId}/invitations/{invId}', [InvitationsController::class, 'revokeInvitation']);
        $r->get('/nooks/{nookId}/members', [InvitationsController::class, 'listMembers']);
        $r->add('DELETE', '/nooks/{nookId}/members/{userId}', [InvitationsController::class, 'revokeMember']);

        // User-scoped: pending invitations & revocation notices
        $r->get('/me/invitations', [InvitationsController::class, 'listForMe']);
        $r->get('/me/revocations', [InvitationsController::class, 'listRevocations']);
        $r->post('/me/invitations/{invId}/accept', [InvitationsController::class, 'acceptInvitation']);
        $r->post('/me/invitations/{invId}/decline', [InvitationsController::class, 'declineInvitation']);
        $r->post('/me/revocations/{revId}/dismiss', [InvitationsController::class, 'dismissRevocation']);

        $r->get('/nooks/{nookId}/stats', [NookStatsController::class, 'stats']);
        $r->get('/nooks/{nookId}/note-types', [NoteTypesController::class, 'list']);
        $r->post('/nooks/{nookId}/note-types', [NoteTypesController::class, 'create']);
        $r->add('PUT', '/nooks/{nookId}/note-types/{typeId}', [NoteTypesController::class, 'update']);
        $r->add('DELETE', '/nooks/{nookId}/note-types/{typeId}', [NoteTypesController::class, 'delete']);
        $r->get('/nooks/{nookId}/note-types/{typeId}/notes', [NoteTypesController::class, 'notes']);

        $r->get('/nooks/{nookId}/link-predicates', [LinkPredicatesController::class, 'list']);
        $r->post('/nooks/{nookId}/link-predicates', [LinkPredicatesController::class, 'create']);
        $r->add('PUT', '/nooks/{nookId}/link-predicates/{predicateId}', [LinkPredicatesController::class, 'update']);
        $r->add('DELETE', '/nooks/{nookId}/link-predicates/{predicateId}', [LinkPredicatesController::class, 'delete']);
        $r->get('/nooks/{nookId}/link-predicates/{predicateId}/rules', [LinkPredicatesController::class, 'rules']);
        $r->add('PUT', '/nooks/{nookId}/link-predicates/{predicateId}/rules', [LinkPredicatesController::class, 'replaceRules']);

        $r->get('/nooks/{nookId}/notes', [NotesController::class, 'list']);
        $r->get('/nooks/{nookId}/notes/{noteId}', [NotesController::class, 'get']);
        $r->post('/nooks/{nookId}/notes', [NotesController::class, 'create']);
        $r->add('PUT', '/nooks/{nookId}/notes/{noteId}', [NotesController::class, 'update']);
        $r->add('DELETE', '/nooks/{nookId}/notes/{noteId}', [NotesController::class, 'delete']);
        $r->get('/nooks/{nookId}/notes/{noteId}/mentions', [NotesController::class, 'mentions']);

        $r->get('/nooks/{nookId}/notes/{noteId}/links', [NoteLinksController::class, 'list']);
        $r->post('/nooks/{nookId}/notes/{noteId}/links', [NoteLinksController::class, 'create']);
        $r->add('DELETE', '/nooks/{nookId}/notes/{noteId}/links/{linkId}', [NoteLinksController::class, 'delete']);


        $r->post('/nooks/{nookId}/notes/{noteId}/file/upload-url', [FileNotesController::class, 'fileUploadUrl']);
        $r->post('/nooks/{nookId}/notes/{noteId}/file/finalize', [FileNotesController::class, 'fileFinalize']);
        $r->get('/nooks/{nookId}/notes/{noteId}/file/download-url', [FileNotesController::class, 'fileDownloadUrl']);

        $r->post('/nooks/{nookId}/file/upload-url', [FileNotesController::class, 'fileUploadUrlInit']);
        $r->post('/nooks/{nookId}/file/finalize', [FileNotesController::class, 'fileFinalizeCreateNote']);

        $r->use('/conversations', new RequireUser());
        $r->use('/conversations', new RequireGroup('paith/notes/'));

        $r->get('/conversations', [ConversationsController::class, 'list']);
        $r->post('/conversations', [ConversationsController::class, 'create']);
        $r->get('/conversations/{conversationId}/messages', [ConversationsController::class, 'listMessages']);
        $r->post('/conversations/{conversationId}/messages', [ConversationsController::class, 'appendMessages']);
        $r->post('/conversations/{conversationId}/note-links', [ConversationsController::class, 'createNoteLink']);

        $r->group('/module_1', [Module1Routes::class, 'register']);
    }
}
