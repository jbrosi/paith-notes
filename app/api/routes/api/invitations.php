<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

return static function (RouteCollector $r, array &$prefixMiddlewares): void {
    // Owner endpoints: manage invitations & members for a nook
    $r->addRoute('POST', '/api/nooks/{nookId}/invitations', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'invite']);
    $r->addRoute('GET', '/api/nooks/{nookId}/invitations', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'listForNook']);
    $r->addRoute('DELETE', '/api/nooks/{nookId}/invitations/{invId}', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'revokeInvitation']);
    $r->addRoute('GET', '/api/nooks/{nookId}/members', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'listMembers']);
    $r->addRoute('DELETE', '/api/nooks/{nookId}/members/{userId}', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'revokeMember']);

    // User endpoints: view and respond to invitations/revocations
    $r->addRoute('GET', '/api/me/invitations', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'listForMe']);
    $r->addRoute('GET', '/api/me/revocations', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'listRevocations']);
    $r->addRoute('POST', '/api/me/invitations/{invId}/accept', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'acceptInvitation']);
    $r->addRoute('POST', '/api/me/invitations/{invId}/decline', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'declineInvitation']);
    $r->addRoute('POST', '/api/me/revocations/{revId}/dismiss', [\Paith\Notes\Api\Http\Controller\InvitationsController::class, 'dismissRevocation']);
};
