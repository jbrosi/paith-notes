<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
});

// ── helpers ──

function ownerHeaders(): array
{
    return [
        'X-Nook-User' => '11111111-1111-4111-8111-111111111111',
        'X-Nook-Groups' => 'paith/notes',
    ];
}

function guestHeaders(): array
{
    return [
        'X-Nook-User' => '22222222-2222-4222-8222-222222222222',
        'X-Nook-Groups' => 'paith/notes',
    ];
}

function thirdHeaders(): array
{
    return [
        'X-Nook-User' => '33333333-3333-4333-8333-333333333333',
        'X-Nook-Groups' => 'paith/notes',
    ];
}

function setupOwnerAndNook(): string
{
    $h = ownerHeaders();
    App::handle('GET', '/api/me', $h, '');

    $res = App::handle(
        'POST',
        '/api/nooks',
        $h,
        json_encode(['name' => 'Shared Nook'], JSON_UNESCAPED_SLASHES)
    );
    $data = json_decode($res['body'], true);
    return (string) ($data['nook']['id'] ?? '');
}

function setupGuest(): void
{
    $pdo = test_pdo();
    // Set the guest email so invitations can match
    App::handle('GET', '/api/me', guestHeaders(), '');
    $pdo->prepare("update global.users set email = :email where id = :id")
        ->execute([':email' => 'guest@example.com', ':id' => guestHeaders()['X-Nook-User']]);
}

function setupThird(): void
{
    $pdo = test_pdo();
    App::handle('GET', '/api/me', thirdHeaders(), '');
    $pdo->prepare("update global.users set email = :email where id = :id")
        ->execute([':email' => 'third@example.com', ':id' => thirdHeaders()['X-Nook-User']]);
}

// ── invitation flow ──

it('owner can invite by email and guest can accept', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Invite guest as readonly
    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    expect($invite['status'])->toBe(200);
    $invData = json_decode($invite['body'], true);
    expect($invData)->toBeArray();
    $invId = (string) ($invData['invitation']['id'] ?? '');
    expect($invId)->not->toBe('');
    expect($invData['invitation']['invited_email'])->toBe('guest@example.com');
    expect($invData['invitation']['role'])->toBe('readonly');

    // Guest sees pending invitation
    $myInv = App::handle('GET', '/api/me/invitations', guestHeaders(), '');
    expect($myInv['status'])->toBe(200);
    $myInvData = json_decode($myInv['body'], true);
    expect($myInvData)->toBeArray();
    expect(count($myInvData['invitations']))->toBe(1);
    expect($myInvData['invitations'][0]['nook_name'])->toBe('Shared Nook');
    expect($myInvData['invitations'][0]['role'])->toBe('readonly');

    // Guest accepts
    $accept = App::handle(
        'POST',
        '/api/me/invitations/' . $invId . '/accept',
        guestHeaders(),
        ''
    );
    expect($accept['status'])->toBe(200);
    $acceptData = json_decode($accept['body'], true);
    expect($acceptData)->toBeArray();
    expect($acceptData['accepted'])->toBe(true);
    expect($acceptData['nook_id'])->toBe($nookId);

    // Guest now sees the nook in their list
    $list = App::handle('GET', '/api/nooks', guestHeaders(), '');
    expect($list['status'])->toBe(200);
    $listData = json_decode($list['body'], true);
    expect($listData)->toBeArray();

    $shared = array_values(array_filter(
        $listData['nooks'],
        static fn(mixed $n): bool => is_array($n) && ($n['id'] ?? '') === $nookId
    ));
    expect(count($shared))->toBe(1);
    expect($shared[0]['role'])->toBe('readonly');
    expect($shared[0]['is_owned'])->toBe(false);
    expect($shared[0]['owner_name'])->not->toBe('');

    // No more pending invitations
    $myInv2 = App::handle('GET', '/api/me/invitations', guestHeaders(), '');
    $myInv2Data = json_decode($myInv2['body'], true);
    expect(count($myInv2Data['invitations']))->toBe(0);
});

it('guest can decline an invitation', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readwrite'], JSON_UNESCAPED_SLASHES)
    );
    $invData = json_decode($invite['body'], true);
    $invId = (string) ($invData['invitation']['id'] ?? '');

    $decline = App::handle(
        'POST',
        '/api/me/invitations/' . $invId . '/decline',
        guestHeaders(),
        ''
    );
    expect($decline['status'])->toBe(200);

    // No pending invitations remain
    $myInv = App::handle('GET', '/api/me/invitations', guestHeaders(), '');
    $myInvData = json_decode($myInv['body'], true);
    expect(count($myInvData['invitations']))->toBe(0);

    // Guest is NOT a member
    $list = App::handle('GET', '/api/nooks', guestHeaders(), '');
    $listData = json_decode($list['body'], true);
    $shared = array_values(array_filter(
        $listData['nooks'],
        static fn(mixed $n): bool => is_array($n) && ($n['id'] ?? '') === $nookId
    ));
    expect(count($shared))->toBe(0);
});

it('owner can list invitations and revoke a pending one', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );

    // List invitations for the nook
    $list = App::handle('GET', '/api/nooks/' . $nookId . '/invitations', ownerHeaders(), '');
    expect($list['status'])->toBe(200);
    $listData = json_decode($list['body'], true);
    expect(count($listData['invitations']))->toBe(1);
    expect($listData['invitations'][0]['status'])->toBe('pending');
    $invId = (string) ($listData['invitations'][0]['id'] ?? '');

    // Revoke it
    $revoke = App::handle(
        'DELETE',
        '/api/nooks/' . $nookId . '/invitations/' . $invId,
        ownerHeaders(),
        ''
    );
    expect($revoke['status'])->toBe(200);

    // Guest no longer sees the invitation
    $myInv = App::handle('GET', '/api/me/invitations', guestHeaders(), '');
    $myInvData = json_decode($myInv['body'], true);
    expect(count($myInvData['invitations']))->toBe(0);
});

it('prevents duplicate pending invitations for the same email', function (): void {
    $nookId = setupOwnerAndNook();

    $first = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    expect($first['status'])->toBe(200);

    $second = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readwrite'], JSON_UNESCAPED_SLASHES)
    );
    expect($second['status'])->toBe(409);
});

it('prevents inviting an existing member', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Manually add guest as member
    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:nook_id, :user_id, 'readwrite')")
        ->execute([':nook_id' => $nookId, ':user_id' => guestHeaders()['X-Nook-User']]);

    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    expect($invite['status'])->toBe(409);
});

// ── readonly enforcement ──

it('readonly user can read notes but cannot create, update, or delete', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Owner creates a note
    $createNote = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/notes',
        ownerHeaders(),
        json_encode(['title' => 'Hello', 'content' => 'World'], JSON_UNESCAPED_SLASHES)
    );
    expect($createNote['status'])->toBe(200);
    $noteId = (string) (json_decode($createNote['body'], true)['note']['id'] ?? '');

    // Invite and accept as readonly
    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    $invId = (string) (json_decode($invite['body'], true)['invitation']['id'] ?? '');
    App::handle('POST', '/api/me/invitations/' . $invId . '/accept', guestHeaders(), '');

    // Can read notes
    $listNotes = App::handle('GET', '/api/nooks/' . $nookId . '/notes', guestHeaders(), '');
    expect($listNotes['status'])->toBe(200);
    $listNotesData = json_decode($listNotes['body'], true);
    expect(count($listNotesData['notes']))->toBe(1);

    // Can read a single note
    $getNote = App::handle('GET', '/api/nooks/' . $nookId . '/notes/' . $noteId, guestHeaders(), '');
    expect($getNote['status'])->toBe(200);

    // Cannot create a note
    $create = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/notes',
        guestHeaders(),
        json_encode(['title' => 'Nope', 'content' => 'Nope'], JSON_UNESCAPED_SLASHES)
    );
    expect($create['status'])->toBe(403);

    // Cannot update a note
    $update = App::handle(
        'PUT',
        '/api/nooks/' . $nookId . '/notes/' . $noteId,
        guestHeaders(),
        json_encode(['title' => 'Changed', 'content' => 'Changed', 'type' => 'anything', 'properties' => []], JSON_UNESCAPED_SLASHES)
    );
    expect($update['status'])->toBe(403);

    // Cannot delete a note
    $delete = App::handle('DELETE', '/api/nooks/' . $nookId . '/notes/' . $noteId, guestHeaders(), '');
    expect($delete['status'])->toBe(403);
});

it('readwrite user can create and edit notes', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Invite and accept as readwrite
    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'guest@example.com', 'role' => 'readwrite'], JSON_UNESCAPED_SLASHES)
    );
    $invId = (string) (json_decode($invite['body'], true)['invitation']['id'] ?? '');
    App::handle('POST', '/api/me/invitations/' . $invId . '/accept', guestHeaders(), '');

    // Can create a note
    $create = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/notes',
        guestHeaders(),
        json_encode(['title' => 'Guest Note', 'content' => 'From guest'], JSON_UNESCAPED_SLASHES)
    );
    expect($create['status'])->toBe(200);
    $noteId = (string) (json_decode($create['body'], true)['note']['id'] ?? '');
    expect($noteId)->not->toBe('');

    // Can update the note
    $update = App::handle(
        'PUT',
        '/api/nooks/' . $nookId . '/notes/' . $noteId,
        guestHeaders(),
        json_encode(['title' => 'Updated', 'content' => 'Changed', 'type' => 'anything', 'properties' => []], JSON_UNESCAPED_SLASHES)
    );
    expect($update['status'])->toBe(200);
});

// ── access revocation ──

it('owner can revoke member access and user sees revocation notice', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Add guest as member directly
    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:nook_id, :user_id, 'readwrite')")
        ->execute([':nook_id' => $nookId, ':user_id' => guestHeaders()['X-Nook-User']]);

    // Revoke access
    $revoke = App::handle(
        'DELETE',
        '/api/nooks/' . $nookId . '/members/' . guestHeaders()['X-Nook-User'],
        ownerHeaders(),
        ''
    );
    expect($revoke['status'])->toBe(200);

    // Guest is no longer a member
    $list = App::handle('GET', '/api/nooks', guestHeaders(), '');
    $listData = json_decode($list['body'], true);
    $shared = array_values(array_filter(
        $listData['nooks'],
        static fn(mixed $n): bool => is_array($n) && ($n['id'] ?? '') === $nookId
    ));
    expect(count($shared))->toBe(0);

    // Guest sees revocation notice
    $rev = App::handle('GET', '/api/me/revocations', guestHeaders(), '');
    expect($rev['status'])->toBe(200);
    $revData = json_decode($rev['body'], true);
    expect(count($revData['revocations']))->toBe(1);
    expect($revData['revocations'][0]['nook_name'])->toBe('Shared Nook');
    $revId = (string) ($revData['revocations'][0]['id'] ?? '');

    // Guest dismisses the notice
    $dismiss = App::handle(
        'POST',
        '/api/me/revocations/' . $revId . '/dismiss',
        guestHeaders(),
        ''
    );
    expect($dismiss['status'])->toBe(200);

    // No more revocation notices
    $rev2 = App::handle('GET', '/api/me/revocations', guestHeaders(), '');
    $rev2Data = json_decode($rev2['body'], true);
    expect(count($rev2Data['revocations']))->toBe(0);
});

it('owner cannot revoke their own access', function (): void {
    $nookId = setupOwnerAndNook();

    $revoke = App::handle(
        'DELETE',
        '/api/nooks/' . $nookId . '/members/' . ownerHeaders()['X-Nook-User'],
        ownerHeaders(),
        ''
    );
    expect($revoke['status'])->toBe(400);
});

// ── members list ──

it('owner can list members of a nook', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Add guest as member
    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:nook_id, :user_id, 'readonly')")
        ->execute([':nook_id' => $nookId, ':user_id' => guestHeaders()['X-Nook-User']]);

    $members = App::handle('GET', '/api/nooks/' . $nookId . '/members', ownerHeaders(), '');
    expect($members['status'])->toBe(200);
    $membersData = json_decode($members['body'], true);
    expect(count($membersData['members']))->toBe(2); // owner + guest
});

// ── authorization: non-owner cannot manage invitations ──

it('non-owner cannot invite or list invitations', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    // Add guest as readwrite member
    $pdo = test_pdo();
    $pdo->prepare("insert into global.nook_members (nook_id, user_id, role) values (:nook_id, :user_id, 'readwrite')")
        ->execute([':nook_id' => $nookId, ':user_id' => guestHeaders()['X-Nook-User']]);

    // Guest (readwrite but not owner) cannot invite
    $invite = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        guestHeaders(),
        json_encode(['email' => 'third@example.com', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    expect($invite['status'])->toBe(403);

    // Guest cannot list invitations
    $list = App::handle('GET', '/api/nooks/' . $nookId . '/invitations', guestHeaders(), '');
    expect($list['status'])->toBe(403);

    // Guest cannot list members
    $members = App::handle('GET', '/api/nooks/' . $nookId . '/members', guestHeaders(), '');
    expect($members['status'])->toBe(403);
});

it('rejects invalid email and role in invite', function (): void {
    $nookId = setupOwnerAndNook();

    $badEmail = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'not-an-email', 'role' => 'readonly'], JSON_UNESCAPED_SLASHES)
    );
    expect($badEmail['status'])->toBe(400);

    $badRole = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/invitations',
        ownerHeaders(),
        json_encode(['email' => 'valid@example.com', 'role' => 'owner'], JSON_UNESCAPED_SLASHES)
    );
    expect($badRole['status'])->toBe(400);
});

it('non-member cannot access nook at all', function (): void {
    $nookId = setupOwnerAndNook();
    setupGuest();

    $list = App::handle('GET', '/api/nooks/' . $nookId . '/notes', guestHeaders(), '');
    expect($list['status'])->toBe(403);
});
