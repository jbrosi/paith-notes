<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.nook_members, global.nooks, global.users cascade');
});

it('returns 401 when X-Nook-User is missing', function (): void {
    $res = App::handle('GET', '/api/me', [], '');

    expect($res['status'])->toBe(401);
    expect($res['headers'])->toHaveKey('Content-Type');

    $data = json_decode($res['body'], true);
    expect($data)->toBeArray();
    expect($data['status'])->toBe('error');
});

it('returns 400 when X-Nook-User is not a UUID', function (): void {
    $res = App::handle('GET', '/api/me', ['X-Nook-User' => 'not-a-uuid'], '');

    expect($res['status'])->toBe(400);

    $data = json_decode($res['body'], true);
    expect($data)->toBeArray();
    expect($data['status'])->toBe('error');
});

it('auto-creates a user and can create/list nooks', function (): void {
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $me = App::handle('GET', '/api/me', $headers, '');
    expect($me['status'])->toBe(200);

    $meData = json_decode($me['body'], true);
    expect($meData)->toBeArray();
    expect($meData['user']['id'])->toBe($userId);

    $initialList = App::handle('GET', '/api/nooks', $headers, '');
    expect($initialList['status'])->toBe(200);

    $initialListData = json_decode($initialList['body'], true);
    expect($initialListData)->toBeArray();
    expect($initialListData['nooks'])->toBeArray();
    expect(count($initialListData['nooks']))->toBe(1);

    $personal = array_values(array_filter(
        $initialListData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['is_personal'] ?? false) === true)
    ));
    expect(count($personal))->toBe(1);
    expect($personal[0]['name'])->toBe('Personal');

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'My First Nook'], JSON_UNESCAPED_SLASHES));
    expect($create['status'])->toBe(200);

    $createData = json_decode($create['body'], true);
    expect($createData)->toBeArray();
    expect($createData['nook']['name'])->toBe('My First Nook');

    $list = App::handle('GET', '/api/nooks', $headers, '');
    expect($list['status'])->toBe(200);

    $listData = json_decode($list['body'], true);
    expect($listData)->toBeArray();
    expect($listData['nooks'])->toBeArray();
    expect(count($listData['nooks']))->toBe(2);

    $personal2 = array_values(array_filter(
        $listData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['is_personal'] ?? false) === true)
    ));
    expect(count($personal2))->toBe(1);
    expect($personal2[0]['name'])->toBe('Personal');

    $created2 = array_values(array_filter(
        $listData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['name'] ?? '') === 'My First Nook')
    ));
    expect(count($created2))->toBe(1);
    expect($created2[0]['is_personal'])->toBe(false);
});

it('can create a note in a nook', function (): void {
    $userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Work'], JSON_UNESCAPED_SLASHES));
    expect($createNook['status'])->toBe(200);

    $createNookData = json_decode($createNook['body'], true);
    expect($createNookData)->toBeArray();
    $nookId = (string)($createNookData['nook']['id'] ?? '');
    expect($nookId)->not->toBe('');

    $createNote = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/notes',
        $headers,
        json_encode(['title' => 'Hello', 'content' => 'World'], JSON_UNESCAPED_SLASHES)
    );
    expect($createNote['status'])->toBe(200);

    $createNoteData = json_decode($createNote['body'], true);
    expect($createNoteData)->toBeArray();
    expect($createNoteData['note']['nook_id'])->toBe($nookId);
    expect($createNoteData['note']['title'])->toBe('Hello');
    expect($createNoteData['note']['content'])->toBe('World');
    $noteId = (string)($createNoteData['note']['id'] ?? '');
    expect($noteId)->not->toBe('');

    $listNotes = App::handle('GET', '/api/nooks/' . $nookId . '/notes', $headers, '');
    expect($listNotes['status'])->toBe(200);

    $listNotesData = json_decode($listNotes['body'], true);
    expect($listNotesData)->toBeArray();
    expect($listNotesData['notes'])->toBeArray();
    expect(count($listNotesData['notes']))->toBe(1);
    expect($listNotesData['notes'][0]['id'])->toBe($noteId);
    expect($listNotesData['notes'][0]['title'])->toBe('Hello');

    $updateNote = App::handle(
        'PUT',
        '/api/nooks/' . $nookId . '/notes/' . $noteId,
        $headers,
        json_encode(['title' => 'Hello 2', 'content' => 'World 2'], JSON_UNESCAPED_SLASHES)
    );
    expect($updateNote['status'])->toBe(200);

    $updateNoteData = json_decode($updateNote['body'], true);
    expect($updateNoteData)->toBeArray();
    expect($updateNoteData['note']['id'])->toBe($noteId);
    expect($updateNoteData['note']['title'])->toBe('Hello 2');
    expect($updateNoteData['note']['content'])->toBe('World 2');

    $pdo = test_pdo();
    $stmt = $pdo->prepare('select title, content from global.notes where id = :id and nook_id = :nook_id');
    $stmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    expect($row)->toBeArray();
    expect((string)($row['title'] ?? ''))->toBe('Hello 2');
    expect((string)($row['content'] ?? ''))->toBe('World 2');
});

it('exposes the personal nook via /api/nooks/personal', function (): void {
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $me = App::handle('GET', '/api/me', $headers, '');
    expect($me['status'])->toBe(200);

    $personal = App::handle('GET', '/api/nooks/personal', $headers, '');
    expect($personal['status'])->toBe(200);

    $personalData = json_decode($personal['body'], true);
    expect($personalData)->toBeArray();
    expect($personalData['nook'])->toBeArray();
    expect($personalData['nook']['id'])->toBeString();
    expect($personalData['nook']['id'])->not->toBe('');
    expect($personalData['nook']['is_personal'])->toBe(true);
});
